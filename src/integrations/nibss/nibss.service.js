'use strict';

const { nibssClient } = require('./client');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');

/**
 * Domain-facing wrapper over the NibssByPhoenix API.
 *
 * Every method returns a normalised shape so the rest of the codebase never
 * has to guess at the provider field naming. The raw body is always kept on
 * `raw` for auditing and for storage on the transaction record.
 *
 * Upstream contract (from https://nibssbyphoenix.onrender.com/api/docs):
 *   POST /api/fintech/onboard                  { name, email }
 *   POST /api/auth/token                       { apiKey, apiSecret }
 *   POST /api/insertBvn                        { bvn, firstName, lastName, dob, phone }
 *   POST /api/validateBvn                      { bvn }
 *   POST /api/insertNin                        { nin, firstName, lastName, dob }
 *   POST /api/validateNin                      { nin }
 *   POST /api/account/create                   { kycType, kycID, dob }        [auth]
 *   GET  /api/account/name-enquiry/{accountNumber}                            [auth]
 *   GET  /api/account/balance/{accountNumber}                                 [auth]
 *   POST /api/transfer                         { from, to, amount }           [auth]
 *   GET  /api/transaction/{ref}                                               [auth]
 *   GET  /api/accounts                                                        [auth]
 */

/** Pull the first present key from a possibly-nested provider payload. */
function pick(payload, keys) {
  if (!payload || typeof payload !== 'object') return undefined;
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') return payload[key];
  }
  // One level of nesting is common: { account: { accountNumber } }.
  for (const nested of ['data', 'response', 'account', 'result', 'details', 'transaction', 'payload']) {
    const inner = payload[nested];
    if (inner && typeof inner === 'object') {
      const found = pick(inner, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const ACCOUNT_NUMBER_KEYS = ['accountNumber', 'account_number', 'accountNo', 'nuban', 'number'];
const ACCOUNT_NAME_KEYS = ['accountName', 'account_name', 'name', 'fullName', 'customerName'];
const BALANCE_KEYS = ['balance', 'availableBalance', 'available_balance', 'accountBalance', 'ledgerBalance'];
const REFERENCE_KEYS = ['reference', 'ref', 'transactionRef', 'transactionReference', 'txnRef', 'id', '_id'];
const STATUS_KEYS = ['status', 'transactionStatus', 'state', 'responseStatus'];

/** Provider status strings vary; fold them into our own vocabulary. */
function normaliseStatus(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
  if (!raw) return 'PENDING';
  if (['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'APPROVED', 'PAID', 'DONE', '00'].includes(raw)) {
    return 'SUCCESS';
  }
  if (['FAILED', 'FAILURE', 'DECLINED', 'REJECTED', 'ERROR', 'CANCELLED'].includes(raw)) return 'FAILED';
  if (['REVERSED', 'REVERSAL', 'REFUNDED'].includes(raw)) return 'REVERSED';
  if (['PENDING', 'PROCESSING', 'IN_PROGRESS', 'INPROGRESS', 'QUEUED', 'NEW'].includes(raw)) return 'PENDING';
  return 'PENDING';
}

/** The provider signals validity through several possible shapes. */
function isAffirmative(payload) {
  if (payload === true) return true;
  if (!payload || typeof payload !== 'object') return false;
  const flag = pick(payload, ['valid', 'isValid', 'verified', 'isVerified', 'success', 'status']);
  if (typeof flag === 'boolean') return flag;
  const text = String(flag === undefined ? '' : flag).toUpperCase();
  if (['TRUE', 'VALID', 'VERIFIED', 'SUCCESS', 'SUCCESSFUL', 'ACTIVE', '00'].includes(text)) return true;
  // A payload that echoes back identity details is itself a successful lookup.
  return Boolean(pick(payload, ['firstName', 'first_name', 'lastName', 'last_name']));
}

const nibssService = {
  client: nibssClient,

  // --- Fintech onboarding (run once, out of band) ------------------------

  /** Registers this bank with NibssByPhoenix. API credentials arrive by email. */
  async onboardFintech({ name, email }) {
    const raw = await nibssClient.post('/api/fintech/onboard', { name, email }, {
      auth: false,
      context: 'fintech onboarding',
    });
    return { raw };
  },

  // --- KYC ---------------------------------------------------------------

  async insertBvn({ bvn, firstName, lastName, dob, phone }) {
    const raw = await nibssClient.post(
      '/api/insertBvn',
      { bvn, firstName, lastName, dob, phone },
      { auth: false, context: 'BVN creation' }
    );
    return { bvn: pick(raw, ['bvn']) || bvn, raw };
  },

  async validateBvn(bvn) {
    const raw = await nibssClient.post('/api/validateBvn', { bvn }, { auth: false, context: 'BVN validation' });
    return {
      valid: isAffirmative(raw),
      firstName: pick(raw, ['firstName', 'first_name']),
      lastName: pick(raw, ['lastName', 'last_name']),
      dateOfBirth: pick(raw, ['dob', 'dateOfBirth', 'date_of_birth']),
      phone: pick(raw, ['phone', 'phoneNumber', 'phone_number']),
      raw,
    };
  },

  async insertNin({ nin, firstName, lastName, dob }) {
    const raw = await nibssClient.post(
      '/api/insertNin',
      { nin, firstName, lastName, dob },
      { auth: false, context: 'NIN creation' }
    );
    return { nin: pick(raw, ['nin']) || nin, raw };
  },

  async validateNin(nin) {
    const raw = await nibssClient.post('/api/validateNin', { nin }, { auth: false, context: 'NIN validation' });
    return {
      valid: isAffirmative(raw),
      firstName: pick(raw, ['firstName', 'first_name']),
      lastName: pick(raw, ['lastName', 'last_name']),
      dateOfBirth: pick(raw, ['dob', 'dateOfBirth', 'date_of_birth']),
      raw,
    };
  },

  // --- Accounts ----------------------------------------------------------

  /**
   * kycType is "BVN" or "NIN" in our domain; dob must be ISO yyyy-mm-dd.
   *
   * The provider rejects an uppercase kycType with a bare 500 ("Account
   * creation failed") and only accepts "bvn" / "nin", so the casing is
   * normalised here at the boundary rather than leaking into our enums.
   */
  async createAccount({ kycType, kycID, dob }) {
    const raw = await nibssClient.post(
      '/api/account/create',
      { kycType: String(kycType).toLowerCase(), kycID, dob },
      { context: 'account creation' }
    );

    const accountNumber = pick(raw, ACCOUNT_NUMBER_KEYS);
    if (!accountNumber) {
      logger.error({ raw }, 'Provider account creation returned no account number');
      throw ApiError.badGateway('NibssByPhoenix did not return an account number', {
        code: 'PROVIDER_ACCOUNT_MALFORMED',
        details: { providerBody: raw },
      });
    }

    return {
      accountNumber: String(accountNumber),
      accountName: pick(raw, ACCOUNT_NAME_KEYS),
      balance: toNumberOrNull(pick(raw, BALANCE_KEYS)),
      providerAccountId: pick(raw, ['id', '_id', 'accountId']),
      raw,
    };
  },

  async nameEnquiry(accountNumber) {
    const raw = await nibssClient.get(`/api/account/name-enquiry/${encodeURIComponent(accountNumber)}`, {
      context: 'name enquiry',
    });
    const accountName = pick(raw, ACCOUNT_NAME_KEYS);
    if (!accountName) {
      throw ApiError.notFound('Account could not be resolved at NibssByPhoenix', {
        code: 'ACCOUNT_NOT_RESOLVED',
      });
    }
    return {
      accountNumber: String(pick(raw, ACCOUNT_NUMBER_KEYS) || accountNumber),
      accountName: String(accountName),
      bankName: pick(raw, ['bankName', 'bank', 'institution', 'fintech', 'fintechName']),
      bankCode: pick(raw, ['bankCode', 'bank_code', 'institutionCode']),
      raw,
    };
  },

  async getBalance(accountNumber) {
    const raw = await nibssClient.get(`/api/account/balance/${encodeURIComponent(accountNumber)}`, {
      context: 'balance enquiry',
    });
    const balance = toNumberOrNull(pick(raw, BALANCE_KEYS));
    if (balance === null) {
      throw ApiError.badGateway('NibssByPhoenix returned an unreadable balance', {
        code: 'PROVIDER_BALANCE_MALFORMED',
        details: { providerBody: raw },
      });
    }
    return { accountNumber: String(accountNumber), balance, raw };
  },

  async listAccounts() {
    const raw = await nibssClient.get('/api/accounts', { context: 'account listing' });
    const list = Array.isArray(raw) ? raw : pick(raw, ['accounts', 'items', 'results']) || [];
    return { accounts: Array.isArray(list) ? list : [], raw };
  },

  // --- Transfers ---------------------------------------------------------

  /** `amount` is in NAIRA - conversion from kobo happens in the caller. */
  async transfer({ from, to, amount }) {
    const raw = await nibssClient.post('/api/transfer', { from, to, amount }, { context: 'funds transfer' });
    return {
      status: normaliseStatus(pick(raw, STATUS_KEYS) === undefined ? 'SUCCESS' : pick(raw, STATUS_KEYS)),
      providerReference: firstDefined(pick(raw, REFERENCE_KEYS)),
      sessionId: pick(raw, ['sessionId', 'session_id', 'nibssSessionId']),
      message: pick(raw, ['message', 'responseMessage', 'description']),
      raw,
    };
  },

  async getTransaction(reference) {
    const raw = await nibssClient.get(`/api/transaction/${encodeURIComponent(reference)}`, {
      context: 'transaction status enquiry',
    });
    return {
      status: normaliseStatus(pick(raw, STATUS_KEYS)),
      reference: firstDefined(pick(raw, REFERENCE_KEYS)) || reference,
      amount: toNumberOrNull(pick(raw, ['amount', 'value'])),
      message: pick(raw, ['message', 'responseMessage', 'description']),
      raw,
    };
  },
};

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function firstDefined(value) {
  return value === undefined || value === null ? undefined : String(value);
}

module.exports = nibssService;
module.exports.__internals = { pick, normaliseStatus, isAffirmative, toNumberOrNull };
