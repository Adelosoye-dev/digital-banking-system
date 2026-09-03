'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { Customer, Account } = require('../models');
const { CUSTOMER_STATUS, KYC_STATUS, ACCOUNT_STATUS } = require('../models/constants');

function extractToken(req) {
  const header = req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * Verifies the customer JWT and attaches the live Customer document.
 *
 * The database lookup on every request is deliberate: it is what makes
 * suspension, deletion and password-change revocation take effect immediately
 * rather than at token expiry.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Missing bearer token');

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { issuer: env.BANK_NAME, audience: 'customer' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Session expired. Please log in again.', { code: 'TOKEN_EXPIRED' });
    }
    throw ApiError.unauthorized('Invalid authentication token', { code: 'TOKEN_INVALID' });
  }

  const customer = await Customer.findById(payload.sub);
  if (!customer) throw ApiError.unauthorized('Account no longer exists', { code: 'CUSTOMER_NOT_FOUND' });

  if (customer.tokenVersion !== (payload.tv || 0)) {
    throw ApiError.unauthorized('Session is no longer valid. Please log in again.', { code: 'TOKEN_REVOKED' });
  }

  if (customer.status === CUSTOMER_STATUS.SUSPENDED) {
    throw ApiError.forbidden('This account has been suspended. Contact support.', { code: 'CUSTOMER_SUSPENDED' });
  }

  req.customer = customer;
  req.auth = { customerId: customer.id, role: customer.role, tokenVersion: customer.tokenVersion };
  next();
});

/** Blocks anything that requires a verified BVN or NIN. */
const requireKyc = asyncHandler(async (req, _res, next) => {
  if (req.customer.kyc?.status !== KYC_STATUS.VERIFIED) {
    throw new ApiError(403, 'Complete BVN or NIN verification before using this feature.', {
      code: 'KYC_REQUIRED',
      details: { currentKycStatus: req.customer.kyc?.status || KYC_STATUS.PENDING },
    });
  }
  next();
});

/**
 * Loads the caller own account onto req.account.
 *
 * This is the single choke point that enforces data isolation for
 * account-scoped operations: the account is always resolved BY OWNER, never
 * by an identifier the caller supplied.
 */
const requireAccount = asyncHandler(async (req, _res, next) => {
  const account = await Account.findOne({ customer: req.customer._id });
  if (!account) {
    throw new ApiError(409, 'You do not have a bank account yet. Create one first.', {
      code: 'ACCOUNT_REQUIRED',
    });
  }
  if (account.status !== ACCOUNT_STATUS.ACTIVE) {
    throw ApiError.forbidden(`Your account is ${account.status.toLowerCase()} and cannot be used.`, {
      code: 'ACCOUNT_NOT_ACTIVE',
    });
  }
  req.account = account;
  next();
});

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.customer || !roles.includes(req.customer.role)) {
      return next(ApiError.forbidden('Insufficient privileges', { code: 'ROLE_REQUIRED' }));
    }
    return next();
  };
}

function signAccessToken(customer) {
  return jwt.sign(
    { sub: customer.id, tv: customer.tokenVersion, role: customer.role, typ: 'access' },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN, issuer: env.BANK_NAME, audience: 'customer' }
  );
}

function signRefreshToken(customer) {
  return jwt.sign(
    { sub: customer.id, tv: customer.tokenVersion, typ: 'refresh' },
    env.JWT_REFRESH_SECRET || env.JWT_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN, issuer: env.BANK_NAME, audience: 'customer-refresh' }
  );
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET || env.JWT_SECRET, {
      issuer: env.BANK_NAME,
      audience: 'customer-refresh',
    });
  } catch (_err) {
    throw ApiError.unauthorized('Invalid or expired refresh token', { code: 'REFRESH_TOKEN_INVALID' });
  }
}

module.exports = {
  authenticate,
  requireKyc,
  requireAccount,
  requireRole,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
};
