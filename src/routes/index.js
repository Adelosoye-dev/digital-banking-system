'use strict';

const express = require('express');
const mongoose = require('mongoose');
const env = require('../config/env');
const { ok } = require('../utils/response');
const asyncHandler = require('../utils/asyncHandler');
const { nibssClient } = require('../integrations/nibss/client');

const authRoutes = require('../modules/auth/auth.routes');
const kycRoutes = require('../modules/kyc/kyc.routes');
const accountRoutes = require('../modules/accounts/accounts.routes');
const transferRoutes = require('../modules/transfers/transfers.routes');
const transactionRoutes = require('../modules/transactions/transactions.routes');

const router = express.Router();

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

router.get('/health', (req, res) =>
  ok(res, {
    status: 'ok',
    bank: env.BANK_NAME,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    database: MONGO_STATES[mongoose.connection.readyState] || 'unknown',
    provider: {
      baseUrl: env.NIBSS_BASE_URL,
      credentialsConfigured: nibssClient.isConfigured,
    },
    timestamp: new Date().toISOString(),
  })
);

/** Deep check - actually reaches out to the provider. Useful before a demo. */
router.get(
  '/health/provider',
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    let reachable = false;
    let detail = null;
    try {
      await nibssClient.authenticate();
      reachable = true;
    } catch (err) {
      detail = err.message;
    }
    return ok(res, { reachable, latencyMs: Date.now() - startedAt, detail }, { message: 'Provider health checked' });
  })
);

router.use('/auth', authRoutes);
router.use('/kyc', kycRoutes);
router.use('/accounts', accountRoutes);
router.use('/transfers', transferRoutes);
router.use('/transactions', transactionRoutes);

module.exports = router;
