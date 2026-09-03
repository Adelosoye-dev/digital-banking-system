'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const { money, nairaToKobo, koboToNaira } = require('../../utils/money');
const { transactionReference, sessionId } = require('../../utils/reference');
const nibss = require('../../integrations/nibss/nibss.service');
const accountsService = require('../accounts/accounts.service');
const { Account, Transaction } = require('../../models');
const { ACCOUNT_STATUS, TXN_TYPE, TXN_DIRECTION, TXN_STATUS } = require('../../models/constants');

/**
 * Funds transfer.
 *
 * The flow is deliberately reserve-then-commit so that a slow or failed
 * provider call can never leave the ledger overdrawn:
 *
 *   1. resolve the destination (name enquiry) and classify intra vs inter bank
 *   2. atomically RESERVE the amount     -> lockedBalance += amount
 *   3. write a PENDING debit leg
 *   4. call NibssByPhoenix
 *   5a. success       -> COMMIT   balance -= amount, lockedBalance -= amount
 *   5b. hard failure  -> RELEASE  lockedBalance -= amount, leg marked FAILED
 *   5c. indeterminate -> HOLD     funds stay locked, leg marked PROCESSING and
 *                                 is reconciled by the status-check endpoint
 *
 * Every balance mutation is a single conditional $inc, so the logic is correct
 * on a standalone mongod where multi-document transactions are unavailable.
 */

// --- Ledger primitives --------------------------------------------------

/** Reserves funds. Returns null when the account cannot cover the amount. */
function reserveFunds(accountId, amountKobo) {
  return Account.findOneAndUpdate(
    {
      _id: accountId,
      status: ACCOUNT_STATUS.ACTIVE,
      // available = balance - lockedBalance must still cover the amount.
      $expr: { $gte: [{ $subtract: ['$balance', '$lockedBalance'] }, amountKobo] },
    },
    { $inc: { lockedBalance: amountKobo } },
    { new: true }
  );
}

function commitDebit(accountId, amountKobo) {
  return Account.findOneAndUpdate(
    { _id: accountId },
    { $inc: { balance: -amountKobo, lockedBalance: -amountKobo }, $set: { lastSyncedAt: new Date() } },
    { new: true }
  );
}

function releaseReservation(accountId, amountKobo) {
  return Account.findOneAndUpdate(
    { _id: accountId },
    { $inc: { lockedBalance: -amountKobo } },
    { new: true }
  );
}

function creditAccount(accountId, amountKobo) {
  return Account.findOneAndUpdate(
    { _id: accountId },
    { $inc: { balance: amountKobo }, $set: { lastSyncedAt: new Date() } },
    { new: true }
  );
}

/** A provider error we cannot interpret as "definitely did not happen". */
function isIndeterminate(err) {
  return (
    err instanceof ApiError &&
    ['PROVIDER_UNREACHABLE', 'PROVIDER_ERROR'].includes(err.code) &&
    err.statusCode >= 500
  );
}

function party(account) {
  return {
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    bankName: account.bankName,
    bankCode: account.bankCode,
  };
}

const transfersService = {
  /**
   * @param customer  authenticated Customer document
   * @param source    the caller own Account document (from requireAccount)
   */
  async transfer(customer, source, input) {
    const { destinationAccountNumber, narration = '', idempotencyKey } = input;
    const amountKobo = nairaToKobo(input.amount);

    // --- Guard rails ----------------------------------------------------
    if (destinationAccountNumber === source.accountNumber) {
      throw ApiError.badRequest('You cannot transfer to your own account', { code: 'SELF_TRANSFER' });
    }
    if (amountKobo < env.MIN_TRANSFER_KOBO) {
      throw ApiError.badRequest(`Minimum transfer amount is ${money(env.MIN_TRANSFER_KOBO).formatted}`, {
        code: 'AMOUNT_TOO_LOW',
      });
    }
    if (amountKobo > env.MAX_TRANSFER_KOBO) {
      throw ApiError.badRequest(`Maximum transfer amount is ${money(env.MAX_TRANSFER_KOBO).formatted}`, {
        code: 'AMOUNT_TOO_HIGH',
      });
    }

    // --- Idempotency ----------------------------------------------------
    if (idempotencyKey) {
      const prior = await Transaction.findOne({ customer: customer._id, idempotencyKey });
      if (prior) {
        logger.info({ customerId: customer.id, idempotencyKey }, 'Replaying idempotent transfer');
        return { transaction: prior.toPublicJSON(), replayed: true };
      }
    }

    // --- Resolve the destination (name enquiry) -------------------------
    const resolved = await accountsService.nameEnquiry(destinationAccountNumber, {
      requesterAccountNumber: source.accountNumber,
    });
    const isIntraBank = resolved.transferType === 'INTRA_BANK';
    const type = isIntraBank ? TXN_TYPE.INTRA_BANK_TRANSFER : TXN_TYPE.INTER_BANK_TRANSFER;

    const beneficiaryAccount = isIntraBank ? await Account.findOne({ accountNumber: destinationAccountNumber }) : null;
    if (isIntraBank && !beneficiaryAccount) {
      throw ApiError.notFound('Beneficiary account could not be found', { code: 'BENEFICIARY_NOT_FOUND' });
    }

    // --- Reserve --------------------------------------------------------
    const reserved = await reserveFunds(source._id, amountKobo);
    if (!reserved) {
      const fresh = await Account.findById(source._id);
      if (fresh && fresh.status !== ACCOUNT_STATUS.ACTIVE) {
        throw ApiError.forbidden(`Your account is ${fresh.status.toLowerCase()} and cannot send money.`, {
          code: 'ACCOUNT_NOT_ACTIVE',
        });
      }
      throw new ApiError(402, 'Insufficient funds for this transfer', {
        code: 'INSUFFICIENT_FUNDS',
        details: {
          requested: money(amountKobo),
          available: money(fresh ? Math.max(0, fresh.balance - fresh.lockedBalance) : 0),
        },
      });
    }

    const balanceBefore = reserved.balance;
    const groupReference = transactionReference('GRP');
    const session = sessionId();

    // --- Pending debit leg ----------------------------------------------
    let debit;
    try {
      debit = await Transaction.create({
        reference: transactionReference('TRX'),
        groupReference,
        sessionId: session,
        customer: customer._id,
        account: source._id,
        type,
        direction: TXN_DIRECTION.DEBIT,
        status: TXN_STATUS.PENDING,
        amount: amountKobo,
        balanceBefore,
        source: party(source),
        destination: {
          accountNumber: resolved.accountNumber,
          accountName: resolved.accountName,
          bankName: resolved.bankName,
          bankCode: resolved.bankCode,
        },
        narration: narration.slice(0, 140),
        idempotencyKey,
      });
    } catch (err) {
      await releaseReservation(source._id, amountKobo);
      if (err.code === 11000) {
        // Two concurrent requests raced on the same idempotency key.
        const prior = await Transaction.findOne({ customer: customer._id, idempotencyKey });
        if (prior) return { transaction: prior.toPublicJSON(), replayed: true };
        throw ApiError.conflict('Duplicate transfer request', { code: 'DUPLICATE_TRANSFER' });
      }
      throw err;
    }

    logger.info(
      {
        customerId: customer.id,
        reference: debit.reference,
        type,
        amount: koboToNaira(amountKobo),
        to: destinationAccountNumber,
      },
      'Initiating transfer'
    );

    // --- Call the provider ----------------------------------------------
    let providerResult;
    try {
      providerResult = await nibss.transfer({
        from: source.accountNumber,
        to: destinationAccountNumber,
        amount: koboToNaira(amountKobo),
      });
    } catch (err) {
      if (isIndeterminate(err)) {
        // We do NOT know whether the money moved. Hold the reservation and let
        // the status-check endpoint resolve it against the provider.
        debit.status = TXN_STATUS.PROCESSING;
        debit.failureReason = 'Awaiting confirmation from NibssByPhoenix';
        debit.providerPayload = { error: err.message, details: err.details };
        await debit.save();

        logger.error(
          { reference: debit.reference, err: err.message },
          'Transfer outcome is indeterminate - funds held pending reconciliation'
        );

        // 202, not an error: the request was accepted and is being resolved.
        return { transaction: debit.toPublicJSON(), pending: true, held: true };
      }

      await releaseReservation(source._id, amountKobo);
      debit.status = TXN_STATUS.FAILED;
      debit.failureReason = err.message;
      debit.balanceAfter = balanceBefore;
      debit.completedAt = new Date();
      debit.providerPayload = { error: err.message, details: err.details };
      await debit.save();

      logger.warn({ reference: debit.reference, err: err.message }, 'Transfer rejected by provider');
      throw err;
    }

    // --- Provider answered, but not necessarily with success -------------
    if (providerResult.status === 'FAILED') {
      await releaseReservation(source._id, amountKobo);
      debit.status = TXN_STATUS.FAILED;
      debit.failureReason = providerResult.message || 'Transfer declined by NibssByPhoenix';
      debit.balanceAfter = balanceBefore;
      debit.completedAt = new Date();
      debit.providerReference = providerResult.providerReference;
      debit.providerPayload = providerResult.raw;
      await debit.save();

      throw ApiError.unprocessable(debit.failureReason, {
        code: 'TRANSFER_DECLINED',
        details: { reference: debit.reference },
      });
    }

    if (providerResult.status === 'PENDING') {
      debit.status = TXN_STATUS.PROCESSING;
      debit.providerReference = providerResult.providerReference;
      debit.sessionId = providerResult.sessionId || session;
      debit.providerPayload = providerResult.raw;
      await debit.save();

      return { transaction: debit.toPublicJSON(), pending: true };
    }

    // --- Commit ----------------------------------------------------------
    const committed = await commitDebit(source._id, amountKobo);

    debit.status = TXN_STATUS.SUCCESS;
    debit.balanceAfter = committed.balance;
    debit.completedAt = new Date();
    debit.providerReference = providerResult.providerReference;
    debit.sessionId = providerResult.sessionId || session;
    debit.providerPayload = providerResult.raw;
    await debit.save();

    // Intra-bank money never leaves the bank, so the beneficiary gets a real
    // credit entry in their own history and their balance moves immediately.
    let creditLeg = null;
    if (isIntraBank) {
      const creditedAccount = await creditAccount(beneficiaryAccount._id, amountKobo);
      creditLeg = await Transaction.create({
        reference: transactionReference('TRX'),
        groupReference,
        sessionId: debit.sessionId,
        customer: beneficiaryAccount.customer,
        account: beneficiaryAccount._id,
        type,
        direction: TXN_DIRECTION.CREDIT,
        status: TXN_STATUS.SUCCESS,
        amount: amountKobo,
        balanceBefore: creditedAccount.balance - amountKobo,
        balanceAfter: creditedAccount.balance,
        source: party(source),
        destination: party(beneficiaryAccount),
        narration: narration.slice(0, 140),
        providerReference: providerResult.providerReference,
        completedAt: new Date(),
      });
    }

    logger.info(
      { reference: debit.reference, type, balanceAfter: koboToNaira(committed.balance) },
      'Transfer completed'
    );

    return {
      transaction: debit.toPublicJSON(),
      beneficiaryCredited: Boolean(creditLeg),
      balance: money(committed.balance),
      availableBalance: money(Math.max(0, committed.balance - committed.lockedBalance)),
    };
  },
};

module.exports = transfersService;
module.exports.__ledger = { reserveFunds, commitDebit, releaseReservation, creditAccount };
