'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { authenticate, requireKyc, requireAccount } = require('../../middleware/auth');
const { transferLimiter } = require('../../middleware/rateLimit');
const controller = require('./transfers.controller');
const schemas = require('./transfers.validators');

const router = express.Router();

// requireAccount resolves the SOURCE account from the token, so a caller can
// never debit an account they do not own - there is no "from" field to forge.
router.post(
  '/',
  authenticate,
  requireKyc,
  requireAccount,
  transferLimiter,
  validate({ body: schemas.transferSchema }),
  controller.transfer
);

module.exports = router;
