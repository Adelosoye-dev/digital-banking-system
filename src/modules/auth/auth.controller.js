'use strict';

const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');
const authService = require('./auth.service');

module.exports = {
  register: asyncHandler(async (req, res) => {
    const data = await authService.register(req.body);
    return created(res, data, 'Registration successful. Complete BVN or NIN verification to continue.');
  }),

  login: asyncHandler(async (req, res) => {
    const data = await authService.login(req.body);
    return ok(res, data, { message: 'Login successful' });
  }),

  refresh: asyncHandler(async (req, res) => {
    const data = await authService.refresh(req.body.refreshToken);
    return ok(res, data, { message: 'Token refreshed' });
  }),

  me: asyncHandler(async (req, res) => {
    const data = await authService.me(req.customer);
    return ok(res, data, { message: 'Profile retrieved' });
  }),

  changePassword: asyncHandler(async (req, res) => {
    const data = await authService.changePassword(req.customer.id, req.body);
    return ok(res, data, { message: 'Password changed. All other sessions have been signed out.' });
  }),
};
