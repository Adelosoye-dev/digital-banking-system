'use strict';

// Every test file mocks the provider through this single hook.
jest.mock('../src/integrations/nibss/nibss.service', () => require('./fakeProvider'));

const request = require('supertest');
const createApp = require('../src/app');
const env = require('../src/config/env');

const app = createApp();
const api = (path) => `${env.API_PREFIX}${path}`;

let counter = 0;

function customerPayload(overrides = {}) {
  counter += 1;
  const suffix = String(Date.now()).slice(-6) + counter;
  return {
    firstName: 'Test',
    lastName: 'Customer',
    email: `customer${suffix}@example.com`,
    phone: `080${suffix.padStart(8, '0').slice(0, 8)}`,
    dateOfBirth: '1995-06-15',
    password: 'Passw0rdTest1',
    ...overrides,
  };
}

async function register(overrides = {}) {
  const payload = customerPayload(overrides);
  const res = await request(app).post(api('/auth/register')).send(payload);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { payload, token: res.body.data.tokens.accessToken, customer: res.body.data.customer };
}

/** Registers, completes KYC and opens a funded account. */
async function onboardFully({ kyc = 'bvn', ...overrides } = {}) {
  const registered = await register(overrides);
  const { token } = registered;

  const kycRes = await request(app).post(api(`/kyc/${kyc}`)).set('Authorization', `Bearer ${token}`).send({});
  if (kycRes.status !== 201) throw new Error(`kyc failed: ${kycRes.status} ${JSON.stringify(kycRes.body)}`);

  const acctRes = await request(app).post(api('/accounts')).set('Authorization', `Bearer ${token}`).send();
  if (acctRes.status !== 201) throw new Error(`account failed: ${acctRes.status} ${JSON.stringify(acctRes.body)}`);

  return {
    ...registered,
    kyc: kycRes.body.data,
    account: acctRes.body.data.account,
    preFunded: acctRes.body.data.preFunded,
  };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { app, api, request, register, onboardFully, customerPayload, auth };
