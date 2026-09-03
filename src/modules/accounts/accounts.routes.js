'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { authenticate, requireKyc, requireAccount } = require('../../middleware/auth');
const controller = require('./accounts.controller');
const schemas = require('./accounts.validators');

const router = express.Router();

router.use(authenticate);

// Account creation is gated on verified KYC - requirement 1 of the brief.
router.post('/', requireKyc, controller.create);

router.get('/me', controller.getMine);
router.get('/balance', validate({ query: schemas.balanceQuery }), controller.getBalance);

// Name enquiry needs an active account of your own, so it cannot be used as an
// anonymous directory of every account on the platform.
router.get(
  '/name-enquiry/:accountNumber',
  requireAccount,
  validate({ params: schemas.nameEnquiryParams }),
  controller.nameEnquiry
);

module.exports = router;
