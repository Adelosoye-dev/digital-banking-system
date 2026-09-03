'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const { money, nairaToKobo, koboToNaira } = require('../../utils/money');
const { transactionReference, sessionId } = require('../../utils/reference');
const nibss = require('../../integrations/nibss/nibss.service');
const { Account, Transaction } = require('../../models');
const {
  KYC_STATUS,
  CUSTOMER_STATUS,
  ACCOUNT_STATUS,
  TXN_TYPE,
  TXN_DIRECTION,
  TXN_STATUS,
} = require('../../models/constants');

/**
 * Account lifecycle.
 *
 * Rules enforced here (and re-stated in the route middleware):
 *   1. KYC must be VERIFIED before an account can be opened.
 *   2. A customer may hold at most MAX_ACCOUNTS_PER_CUSTOMER accounts (default 1).
 *   3. A new account is pre-funded with OPENING_BALANCE_KOBO (default NGN 15,000)
 *      and that funding is written to the ledger as an OPENING_CREDIT entry.
 *
 * NibssByPhoenix is the system of record for money. Our Account.balance is a
 * mirror that is refreshed on every balance enquiry and after every transfer.
 */

// --- Name-enquiry cache -------------------------------------------------
// Name enquiry is called immediately before most transfers, so a short TTL
// cache removes a redundant upstream round trip without risking staleness.
const nameCache = new Map();
const NAME_CACHE_MAX = 500;

function cacheGet(accountNumber) {
  const hit = nameCache.get(accountNumber);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    nameCache.delete(accountNumber);
    return null;
  }
  return hit.value;
}

function cacheSet(accountNumber, value) {
  if (env.NAME_ENQUIRY_TTL_SECONDS <= 0) return;
  if (nameCache.size >= NAME_CACHE_MAX) nameCache.delete(nameCache.keys().next().value);
  nameCache.set(accountNumber, { value, expiresAt: Date.now() + env.NAME_ENQUIRY_TTL_SECONDS * 1000 });
}

const accountsService = {
  /** Opens the customer single bank account. */
  async create(customer) {
    if (customer.kyc?.status !== KYC_STATUS.VERIFIED) {
      throw new ApiError(403, 'Complete BVN or NIN verification before opening an account.', {
        code: 'KYC_REQUIRED',
        details: { currentKycStatus: customer.kyc?.status || KYC_STATUS.PENDING },
      });
    }

    const existingCount = await Account.countDocuments({ customer: customer._id });
    if (existingCount >= env.MAX_ACCOUNTS_PER_CUSTOMER) {
      const existing = await Account.findOne({ customer: customer._id });
      throw ApiError.conflict(
        `Each customer may hold a maximum of ${env.MAX_ACCOUNTS_PER_CUSTOMER} account.`,
        { code: 'ACCOUNT_LIMIT_REACHED', details: { account: existing ? existing.toPublicJSON() : null } }
      );
    }

    const { kyc } = customer;
    logger.info({ customerId: customer.id, kycType: kyc.type }, 'Creating account at NibssByPhoenix');

    const providerAccount = await nibss.createAccount({
      kycType: kyc.type,
      kycID: kyc.identifier,
      dob: kyc.dateOfBirth,
    });

    // Trust the provider balance when it reports one; otherwise fall back to
    // the configured opening balance so the account is still testable.
    const providerKobo =
      providerAccount.balance === null || providerAccount.balance === undefined
        ? null
        : nairaToKobo(providerAccount.balance);

    let openingKobo = providerKobo;
    if (openingKobo === null || openingKobo === 0) {
      openingKobo = env.OPENING_BALANCE_KOBO;
      logger.warn(
        { customerId: customer.id, providerBalance: providerAccount.balance },
        'Provider reported no opening balance - seeding the ledger with the configured pre-funding amount'
      );
    }

    let account;
    try {
      account = await Account.create({
        customer: customer._id,
        accountNumber: providerAccount.accountNumber,
        accountName: providerAccount.accountName || `${customer.firstName} ${customer.lastName}`.toUpperCase(),
        balance: openingKobo,
        kycType: kyc.type,
        providerAccountId: providerAccount.providerAccountId,
        providerPayload: providerAccount.raw,
        lastSyncedAt: new Date(),
        status: ACCOUNT_STATUS.ACTIVE,
      });
    } catch (err) {
      if (err.code === 11000) {
        throw ApiError.conflict('That account number is already registered in this bank', {
          code: 'ACCOUNT_NUMBER_EXISTS',
        });
      }
      throw err;
    }

    // Ledger entry for the pre-funding, so the opening balance is auditable.
    await Transaction.create({
      reference: transactionReference('OPN'),
      groupReference: transactionReference('GRP'),
      sessionId: sessionId(),
      customer: customer._id,
      account: account._id,
      type: TXN_TYPE.OPENING_CREDIT,
      direction: TXN_DIRECTION.CREDIT,
      status: TXN_STATUS.SUCCESS,
      amount: openingKobo,
      balanceBefore: 0,
      balanceAfter: openingKobo,
      source: { accountName: `${env.BANK_NAME} Funding`, bankName: env.BANK_NAME, bankCode: env.BANK_CODE },
      destination: {
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        bankCode: account.bankCode,
      },
      narration: 'Account opening pre-funding',
      completedAt: new Date(),
    });

    if (customer.status !== CUSTOMER_STATUS.ACTIVE) {
      customer.status = CUSTOMER_STATUS.ACTIVE;
      await customer.save({ validateBeforeSave: false });
    }

    logger.info(
      { customerId: customer.id, accountNumber: account.accountNumber, opening: koboToNaira(openingKobo) },
      'Account created and pre-funded'
    );

    return { account: account.toPublicJSON(), preFunded: money(openingKobo), nextStep: 'READY' };
  },

  /** The caller own account. Resolved by owner, never by a client-supplied id. */
  async getMine(customer) {
    const account = await Account.findOne({ customer: customer._id });
    if (!account) {
      throw ApiError.notFound('You do not have a bank account yet. Create one to get started.', {
        code: 'ACCOUNT_NOT_FOUND',
      });
    }
    return account.toPublicJSON();
  },

  /**
   * Live balance. Reads the provider, reconciles our mirror, and reports any
   * drift rather than silently hiding it.
   */
  async getBalance(customer, { refresh = true } = {}) {
    const account = await Account.findOne({ customer: customer._id });
    if (!account) {
      throw ApiError.notFound('You do not have a bank account yet.', { code: 'ACCOUNT_NOT_FOUND' });
    }

    if (!refresh) {
      return { ...account.toPublicJSON(), source: 'LEDGER' };
    }

    try {
      const providerBalance = await nibss.getBalance(account.accountNumber);
      const providerKobo = nairaToKobo(providerBalance.balance);
      const driftKobo = providerKobo - account.balance;

      if (driftKobo !== 0) {
        logger.warn(
          { accountNumber: account.accountNumber, ledger: account.balance, provider: providerKobo },
          'Ledger balance drifted from provider - reconciling to provider'
        );
        account.balance = providerKobo;
      }
      account.lastSyncedAt = new Date();
      await account.save({ validateBeforeSave: false });

      return {
        ...account.toPublicJSON(),
        source: 'PROVIDER',
        reconciled: driftKobo !== 0,
        drift: driftKobo === 0 ? null : money(driftKobo),
      };
    } catch (err) {
      // A provider outage must not hide the customer money from them.
      logger.error({ err: err.message, accountNumber: account.accountNumber }, 'Balance enquiry fell back to ledger');
      return {
        ...account.toPublicJSON(),
        source: 'LEDGER',
        stale: true,
        note: 'Live balance is temporarily unavailable; showing the last known ledger balance.',
      };
    }
  },

  /**
   * Name enquiry - resolve a destination account before a transfer.
   *
   * Local accounts answer from our own records (and are flagged intra-bank);
   * everything else is resolved through NibssByPhoenix.
   */
  async nameEnquiry(accountNumber, { requesterAccountNumber } = {}) {
    if (requesterAccountNumber && requesterAccountNumber === accountNumber) {
      throw ApiError.badRequest('That is your own account number', { code: 'SELF_ENQUIRY' });
    }

    const cached = cacheGet(accountNumber);
    if (cached) return { ...cached, cached: true };

    const local = await Account.findOne({ accountNumber });
    if (local) {
      if (local.status !== ACCOUNT_STATUS.ACTIVE) {
        throw ApiError.unprocessable('That account cannot receive funds at the moment', {
          code: 'ACCOUNT_NOT_ACTIVE',
        });
      }
      // Only the counterparty projection - never the balance or the owner.
      const result = { ...local.toCounterpartyJSON(), transferType: 'INTRA_BANK', cached: false };
      cacheSet(accountNumber, result);
      return result;
    }

    const resolved = await nibss.nameEnquiry(accountNumber);
    const result = {
      accountNumber: resolved.accountNumber,
      accountName: resolved.accountName,
      bankName: resolved.bankName || 'External Bank',
      bankCode: resolved.bankCode || null,
      transferType: 'INTER_BANK',
      cached: false,
    };
    cacheSet(accountNumber, result);
    return result;
  },

  /** Clears cached name-enquiry results (used by tests and after account changes). */
  clearNameCache() {
    nameCache.clear();
  },
};

module.exports = accountsService;
