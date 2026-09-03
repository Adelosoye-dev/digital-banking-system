'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const controller = require('./transactions.controller');
const schemas = require('./transactions.validators');

const router = express.Router();

// Everything below is scoped to req.customer inside the service layer.
router.use(authenticate);

router.get('/', validate({ query: schemas.historyQuery }), controller.history);
router.get('/summary', controller.summary);
router.get(
  '/:reference',
  validate({ params: schemas.referenceParams, query: schemas.refreshQuery }),
  controller.getByReference
);

module.exports = router;
