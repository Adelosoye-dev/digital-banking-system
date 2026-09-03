'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const transfersService = require('./transfers.service');

module.exports = {
  transfer: asyncHandler(async (req, res) => {
    // An Idempotency-Key header is honoured as an alternative to the body field.
    const idempotencyKey = req.body.idempotencyKey || req.get('Idempotency-Key') || undefined;

    const result = await transfersService.transfer(req.customer, req.account, { ...req.body, idempotencyKey });

    if (result.replayed) {
      return ok(res, result, { message: 'Transfer already processed (idempotent replay)' });
    }
    if (result.pending) {
      return ok(res, result, {
        status: 202,
        message: 'Transfer accepted and is being processed. Poll the transaction status for the outcome.',
      });
    }
    return ok(res, result, { status: 201, message: 'Transfer successful' });
  }),
};
