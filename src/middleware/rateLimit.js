'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

function build({ windowMs, max, message, code, byUser = false }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Never rate-limit the test suite into flakiness.
    skip: () => env.isTest,
    // ipKeyGenerator normalises IPv6 to a /64 subnet, so a client cannot hop
    // addresses within its own prefix to reset the counter.
    keyGenerator: (req) => (byUser && req.auth ? `u:${req.auth.customerId}` : ipKeyGenerator(req.ip)),
    handler: (_req, _res, next) => next(ApiError.tooMany(message, { code })),
  });
}

/** Broad protection for the whole API surface. */
const globalLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  message: 'Too many requests. Please slow down.',
  code: 'RATE_LIMITED',
});

/** Credential endpoints get a much tighter budget to blunt brute force. */
const authLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  message: 'Too many authentication attempts. Try again in a minute.',
  code: 'AUTH_RATE_LIMITED',
});

/** Money movement is per-customer, not per-IP, so shared NATs are not penalised. */
const transferLimiter = build({
  windowMs: 60_000,
  max: 20,
  byUser: true,
  message: 'Too many transfer attempts. Please wait a moment.',
  code: 'TRANSFER_RATE_LIMITED',
});

module.exports = { globalLimiter, authLimiter, transferLimiter };
