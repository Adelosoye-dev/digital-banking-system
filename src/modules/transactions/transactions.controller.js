'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok, paginated } = require('../../utils/response');
const transactionsService = require('./transactions.service');

module.exports = {
  history: asyncHandler(async (req, res) => {
    const { items, total, page, limit } = await transactionsService.history(req.customer, req.validatedQuery);
    return paginated(res, items, { page, limit, total, message: 'Transaction history retrieved' });
  }),

  summary: asyncHandler(async (req, res) =>
    ok(res, await transactionsService.summary(req.customer), { message: 'Summary retrieved' })
  ),

  getByReference: asyncHandler(async (req, res) => {
    const { refresh } = req.validatedQuery || { refresh: true };
    const data = await transactionsService.getByReference(req.customer, req.params.reference, { refresh });
    return ok(res, data, { message: 'Transaction status retrieved' });
  }),
};
