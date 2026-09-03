'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const controller = require('./kyc.controller');
const schemas = require('./kyc.validators');

const router = express.Router();

// Every KYC route belongs to the authenticated caller - never to an id in the URL.
router.use(authenticate);

router.get('/status', controller.status);
router.post('/bvn', validate({ body: schemas.createBvnSchema }), controller.createBvn);
router.post('/nin', validate({ body: schemas.createNinSchema }), controller.createNin);
router.post('/verify', validate({ body: schemas.verifySchema }), controller.verify);

module.exports = router;
