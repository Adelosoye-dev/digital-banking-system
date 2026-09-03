'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const kycService = require('./kyc.service');

module.exports = {
  status: asyncHandler(async (req, res) =>
    ok(res, kycService.getStatus(req.customer), { message: 'KYC status retrieved' })
  ),

  createBvn: asyncHandler(async (req, res) => {
    const data = await kycService.createBvn(req.customer, req.body);
    return created(res, data, 'BVN created and verified. You can now open an account.');
  }),

  createNin: asyncHandler(async (req, res) => {
    const data = await kycService.createNin(req.customer, req.body);
    return created(res, data, 'NIN created and verified. You can now open an account.');
  }),

  verify: asyncHandler(async (req, res) => {
    const data = await kycService.verifyExisting(req.customer, req.body);
    return ok(res, data, { message: `${req.body.type} verified. You can now open an account.` });
  }),
};
