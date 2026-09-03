'use strict';

const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const { Customer, Account } = require('../../models');
const { CUSTOMER_STATUS } = require('../../models/constants');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../middleware/auth');

// A real bcrypt hash of a value nobody can supply, used only to burn the same
// CPU time on a login for an email that does not exist.
const DUMMY_HASH = bcrypt.hashSync('__no_such_customer__', 10);

function tokenBundle(customer) {
  return {
    accessToken: signAccessToken(customer),
    refreshToken: signRefreshToken(customer),
    tokenType: 'Bearer',
    expiresIn: env.JWT_EXPIRES_IN,
  };
}

async function profileFor(customer) {
  const account = await Account.findOne({ customer: customer._id });
  return {
    customer: customer.toJSON(),
    account: account ? account.toPublicJSON() : null,
    nextStep: nextStepFor(customer, account),
  };
}

/** Tells the client exactly what to do next in the onboarding funnel. */
function nextStepFor(customer, account) {
  if (customer.status === CUSTOMER_STATUS.SUSPENDED) return 'CONTACT_SUPPORT';
  if (!customer.isKycVerified) return 'COMPLETE_KYC';
  if (!account) return 'CREATE_ACCOUNT';
  return 'READY';
}

const authService = {
  async register(payload) {
    const existing = await Customer.findOne({
      $or: [{ email: payload.email }, { phone: payload.phone }],
    }).lean();

    if (existing) {
      const field = existing.email === payload.email ? 'email address' : 'phone number';
      throw ApiError.conflict(`An account with that ${field} already exists`, { code: 'CUSTOMER_EXISTS' });
    }

    const customer = await Customer.create({ ...payload, status: CUSTOMER_STATUS.PENDING_KYC });
    logger.info({ customerId: customer.id }, 'Customer registered');

    return { ...(await profileFor(customer)), tokens: tokenBundle(customer) };
  },

  async login({ email, password }) {
    const customer = await Customer.findOne({ email }).select('+password');

    // Always run a bcrypt comparison so a missing account and a wrong password
    // cost the same time - no user enumeration through response latency.
    const valid = customer
      ? await customer.comparePassword(password)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    if (!customer || !valid) {
      throw ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
    }

    if (customer.status === CUSTOMER_STATUS.SUSPENDED) {
      throw ApiError.forbidden('This account has been suspended. Contact support.', { code: 'CUSTOMER_SUSPENDED' });
    }

    customer.lastLoginAt = new Date();
    await customer.save({ validateBeforeSave: false });

    logger.info({ customerId: customer.id }, 'Customer logged in');
    return { ...(await profileFor(customer)), tokens: tokenBundle(customer) };
  },

  async refresh(refreshToken) {
    const payload = verifyRefreshToken(refreshToken);
    if (payload.typ !== 'refresh') {
      throw ApiError.unauthorized('That is not a refresh token', { code: 'REFRESH_TOKEN_INVALID' });
    }

    const customer = await Customer.findById(payload.sub);
    if (!customer || customer.tokenVersion !== (payload.tv || 0)) {
      throw ApiError.unauthorized('Refresh token is no longer valid', { code: 'REFRESH_TOKEN_REVOKED' });
    }
    if (customer.status === CUSTOMER_STATUS.SUSPENDED) {
      throw ApiError.forbidden('This account has been suspended.', { code: 'CUSTOMER_SUSPENDED' });
    }

    return { tokens: tokenBundle(customer) };
  },

  async me(customer) {
    return profileFor(customer);
  },

  async changePassword(customerId, { currentPassword, newPassword }) {
    const customer = await Customer.findById(customerId).select('+password');
    if (!customer) throw ApiError.notFound('Customer not found');

    if (!(await customer.comparePassword(currentPassword))) {
      throw ApiError.unauthorized('Current password is incorrect', { code: 'INVALID_CREDENTIALS' });
    }

    customer.password = newPassword;
    // Invalidate every token issued before this moment.
    customer.tokenVersion += 1;
    await customer.save();

    logger.info({ customerId: customer.id }, 'Password changed - existing sessions revoked');
    return { tokens: tokenBundle(customer) };
  },
};

module.exports = authService;
module.exports.nextStepFor = nextStepFor;
