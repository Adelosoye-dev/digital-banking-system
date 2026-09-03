'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const accountsService = require('./accounts.service');

module.exports = {
  create: asyncHandler(async (req, res) => {
    const data = await accountsService.create(req.customer);
    return created(res, data, 'Account created and pre-funded successfully');
  }),

  getMine: asyncHandler(async (req, res) =>
    ok(res, await accountsService.getMine(req.customer), { message: 'Account retrieved' })
  ),

  getBalance: asyncHandler(async (req, res) => {
    const { refresh } = req.validatedQuery || { refresh: true };
    const data = await accountsService.getBalance(req.customer, { refresh });
    return ok(res, data, { message: 'Balance retrieved' });
  }),

  nameEnquiry: asyncHandler(async (req, res) => {
    const data = await accountsService.nameEnquiry(req.params.accountNumber, {
      requesterAccountNumber: req.account ? req.account.accountNumber : undefined,
    });
    return ok(res, data, { message: 'Account resolved' });
  }),
};
