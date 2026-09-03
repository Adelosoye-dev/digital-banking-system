'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const { authLimiter } = require('../../middleware/rateLimit');
const controller = require('./auth.controller');
const schemas = require('./auth.validators');

const router = express.Router();

router.post('/register', authLimiter, validate({ body: schemas.registerSchema }), controller.register);
router.post('/login', authLimiter, validate({ body: schemas.loginSchema }), controller.login);
router.post('/refresh', authLimiter, validate({ body: schemas.refreshSchema }), controller.refresh);

router.get('/me', authenticate, controller.me);
router.post(
  '/change-password',
  authenticate,
  authLimiter,
  validate({ body: schemas.changePasswordSchema }),
  controller.changePassword
);

module.exports = router;
