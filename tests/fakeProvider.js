'use strict';

/**
 * In-memory stand-in for NibssByPhoenix.
 *
 * It mirrors the real contract closely enough to exercise our business rules
 * (identity records must exist before an account can be opened; balances move
 * only when a transfer succeeds) without hitting the network, so the suite is
 * deterministic and runs offline.
 */

const state = {
  bvns: new Map(),
  nins: new Map(),
  accounts: new Map(), // accountNumber -> { accountName, balance (naira), kycID }
  transactions: new Map(),
  nextAccount: 1000000001,
  // Test hooks
  failNextTransfer: null, // 'DECLINE' | 'UNREACHABLE' | 'PENDING'
  openingBalance: 15000,
};

function reset() {
  state.bvns.clear();
  state.nins.clear();
  state.accounts.clear();
  state.transactions.clear();
  state.nextAccount = 1000000001;
  state.failNextTransfer = null;
  state.openingBalance = 15000;
}

/** Registers an account that this bank does not own, for inter-bank tests. */
function seedExternalAccount(accountNumber, accountName, balance = 0) {
  state.accounts.set(accountNumber, { accountName, balance, external: true });
  return accountNumber;
}

const ApiError = require('../src/utils/ApiError');

const fakeService = {
  async onboardFintech({ name, email }) {
    return { raw: { apiKey: 'test-key', apiSecret: 'test-secret', name, email } };
  },

  async insertBvn({ bvn, firstName, lastName, dob, phone }) {
    state.bvns.set(bvn, { firstName, lastName, dob, phone });
    return { bvn, raw: { bvn, message: 'BVN created successfully' } };
  },

  async validateBvn(bvn) {
    const record = state.bvns.get(bvn);
    if (!record) return { valid: false, raw: { message: 'BVN not found' } };
    return { valid: true, ...record, dateOfBirth: record.dob, raw: { ...record, bvn, valid: true } };
  },

  async insertNin({ nin, firstName, lastName, dob }) {
    state.nins.set(nin, { firstName, lastName, dob });
    return { nin, raw: { nin, message: 'NIN created successfully' } };
  },

  async validateNin(nin) {
    const record = state.nins.get(nin);
    if (!record) return { valid: false, raw: { message: 'NIN not found' } };
    return { valid: true, ...record, dateOfBirth: record.dob, raw: { ...record, nin, valid: true } };
  },

  async createAccount({ kycType, kycID }) {
    const registry = kycType === 'BVN' ? state.bvns : state.nins;
    const identity = registry.get(kycID);
    if (!identity) {
      throw new ApiError(404, 'KYC record not found', { code: 'PROVIDER_ERROR' });
    }

    const accountNumber = String(state.nextAccount);
    state.nextAccount += 1;
    const accountName = `${identity.firstName} ${identity.lastName}`.toUpperCase();

    state.accounts.set(accountNumber, { accountName, balance: state.openingBalance, kycID });
    return {
      accountNumber,
      accountName,
      balance: state.openingBalance,
      providerAccountId: `acct_${accountNumber}`,
      raw: { accountNumber, accountName, balance: state.openingBalance },
    };
  },

  async nameEnquiry(accountNumber) {
    const account = state.accounts.get(accountNumber);
    if (!account) throw new ApiError(404, 'Account not found', { code: 'PROVIDER_ERROR' });
    return {
      accountNumber,
      accountName: account.accountName,
      bankName: account.external ? 'Colleague Bank' : 'Phoenix Trust Bank',
      bankCode: account.external ? '000999' : '000001',
      raw: account,
    };
  },

  async getBalance(accountNumber) {
    const account = state.accounts.get(accountNumber);
    if (!account) throw new ApiError(404, 'Account not found', { code: 'PROVIDER_ERROR' });
    return { accountNumber, balance: account.balance, raw: { balance: account.balance } };
  },

  async listAccounts() {
    return { accounts: [...state.accounts.entries()].map(([n, a]) => ({ accountNumber: n, ...a })), raw: {} };
  },

  async transfer({ from, to, amount }) {
    if (state.failNextTransfer === 'UNREACHABLE') {
      state.failNextTransfer = null;
      throw ApiError.unavailable('Could not reach NibssByPhoenix', { code: 'PROVIDER_UNREACHABLE' });
    }
    if (state.failNextTransfer === 'DECLINE') {
      state.failNextTransfer = null;
      return { status: 'FAILED', message: 'Declined by provider', raw: { status: 'FAILED' } };
    }

    const source = state.accounts.get(from);
    const destination = state.accounts.get(to);
    if (!source) throw new ApiError(404, 'Source account not found', { code: 'PROVIDER_ERROR' });
    if (!destination) throw new ApiError(404, 'Destination account not found', { code: 'PROVIDER_ERROR' });
    if (source.balance < amount) {
      return { status: 'FAILED', message: 'Insufficient funds at provider', raw: { status: 'FAILED' } };
    }

    source.balance -= amount;
    destination.balance += amount;

    const reference = `PRV-${state.transactions.size + 1}`;
    const pending = state.failNextTransfer === 'PENDING';
    if (pending) state.failNextTransfer = null;

    const record = { reference, from, to, amount, status: pending ? 'PENDING' : 'SUCCESS' };
    state.transactions.set(reference, record);

    return {
      status: record.status,
      providerReference: reference,
      sessionId: `SES${reference}`,
      message: 'ok',
      raw: record,
    };
  },

  async getTransaction(reference) {
    const record = state.transactions.get(reference);
    if (!record) throw new ApiError(404, 'Transaction not found', { code: 'PROVIDER_ERROR' });
    return { status: record.status, reference, amount: record.amount, message: 'ok', raw: record };
  },
};

module.exports = fakeService;
module.exports.reset = reset;
module.exports.state = state;
module.exports.seedExternalAccount = seedExternalAccount;
