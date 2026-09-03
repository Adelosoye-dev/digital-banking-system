'use strict';

const { app, api, request, register, onboardFully, auth, customerPayload } = require('./helpers');
const { Account, Transaction } = require('../src/models');

describe('Customer onboarding and account creation', () => {
  describe('registration', () => {
    it('registers a customer and reports COMPLETE_KYC as the next step', async () => {
      const payload = customerPayload();
      const res = await request(app).post(api('/auth/register')).send(payload);

      expect(res.status).toBe(201);
      expect(res.body.data.nextStep).toBe('COMPLETE_KYC');
      expect(res.body.data.customer.email).toBe(payload.email.toLowerCase());
      expect(res.body.data.account).toBeNull();
      expect(res.body.data.tokens.accessToken).toEqual(expect.any(String));
    });

    it('never returns the password hash', async () => {
      const res = await request(app).post(api('/auth/register')).send(customerPayload());
      expect(JSON.stringify(res.body)).not.toContain('$2a$');
      expect(res.body.data.customer.password).toBeUndefined();
    });

    it('rejects a duplicate email', async () => {
      const payload = customerPayload();
      await request(app).post(api('/auth/register')).send(payload);
      const res = await request(app)
        .post(api('/auth/register'))
        .send({ ...customerPayload(), email: payload.email });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CUSTOMER_EXISTS');
    });

    it('rejects a weak password and an under-18 date of birth', async () => {
      const weak = await request(app)
        .post(api('/auth/register'))
        .send(customerPayload({ password: 'password' }));
      expect(weak.status).toBe(422);

      const young = await request(app)
        .post(api('/auth/register'))
        .send(customerPayload({ dateOfBirth: '2020-01-01' }));
      expect(young.status).toBe(422);
    });
  });

  describe('the KYC gate', () => {
    it('refuses account creation before KYC', async () => {
      const { token } = await register();
      const res = await request(app).post(api('/accounts')).set(auth(token)).send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('KYC_REQUIRED');
    });

    it('creates and verifies a BVN, generating a synthetic 11-digit value', async () => {
      const { token } = await register();
      const res = await request(app).post(api('/kyc/bvn')).set(auth(token)).send({});

      expect(res.status).toBe(201);
      expect(res.body.data.bvn).toMatch(/^\d{11}$/);
      expect(res.body.data.kyc.status).toBe('VERIFIED');
      expect(res.body.data.kyc.canCreateAccount).toBe(true);
      expect(res.body.data.nextStep).toBe('CREATE_ACCOUNT');
    });

    it('creates and verifies a NIN', async () => {
      const { token } = await register();
      const res = await request(app).post(api('/kyc/nin')).set(auth(token)).send({});

      expect(res.status).toBe(201);
      expect(res.body.data.nin).toMatch(/^\d{11}$/);
      expect(res.body.data.kyc.type).toBe('NIN');
    });

    it('masks the identity number when reporting status', async () => {
      const { token } = await register();
      await request(app).post(api('/kyc/bvn')).set(auth(token)).send({});
      const res = await request(app).get(api('/kyc/status')).set(auth(token));

      expect(res.body.data.identifier).toMatch(/^\d{3}\*+\d{2}$/);
    });

    it('refuses a second KYC once one is verified', async () => {
      const { token } = await register();
      await request(app).post(api('/kyc/bvn')).set(auth(token)).send({});
      const res = await request(app).post(api('/kyc/nin')).set(auth(token)).send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('KYC_ALREADY_VERIFIED');
    });

    it('refuses an identity document already claimed by another customer', async () => {
      const first = await register();
      const created = await request(app).post(api('/kyc/bvn')).set(auth(first.token)).send({});
      const { bvn } = created.body.data;

      const second = await register();
      const res = await request(app).post(api('/kyc/bvn')).set(auth(second.token)).send({ bvn });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('KYC_IDENTIFIER_TAKEN');
    });

    it('rejects a malformed BVN', async () => {
      const { token } = await register();
      const res = await request(app).post(api('/kyc/bvn')).set(auth(token)).send({ bvn: '123' });
      expect(res.status).toBe(422);
    });
  });

  describe('account creation', () => {
    it('opens an account pre-funded with NGN 15,000 after KYC', async () => {
      const { account, preFunded } = await onboardFully();

      expect(account.accountNumber).toEqual(expect.any(String));
      expect(account.status).toBe('ACTIVE');
      expect(account.balance.amount).toBe(15000);
      expect(account.balance.amountInKobo).toBe(1500000);
      expect(preFunded.formatted).toContain('15,000.00');
    });

    it('writes the pre-funding to the ledger as an OPENING_CREDIT entry', async () => {
      const { token } = await onboardFully();
      const res = await request(app).get(api('/transactions')).set(auth(token));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        type: 'OPENING_CREDIT',
        direction: 'CREDIT',
        status: 'SUCCESS',
      });
      expect(res.body.data[0].amount.amount).toBe(15000);
    });

    it('allows only one account per customer', async () => {
      const { token } = await onboardFully();
      const res = await request(app).post(api('/accounts')).set(auth(token)).send();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_LIMIT_REACHED');
      expect(await Account.countDocuments()).toBe(1);
    });

    it('moves the customer to ACTIVE and reports READY', async () => {
      const { token } = await onboardFully();
      const res = await request(app).get(api('/auth/me')).set(auth(token));

      expect(res.body.data.customer.status).toBe('ACTIVE');
      expect(res.body.data.nextStep).toBe('READY');
      expect(res.body.data.account.accountNumber).toEqual(expect.any(String));
    });

    it('creates exactly one ledger entry per opened account', async () => {
      await onboardFully();
      await onboardFully({ kyc: 'nin' });
      expect(await Transaction.countDocuments({ type: 'OPENING_CREDIT' })).toBe(2);
    });
  });

  describe('balance enquiry', () => {
    it('returns the live provider balance', async () => {
      const { token } = await onboardFully();
      const res = await request(app).get(api('/accounts/balance')).set(auth(token));

      expect(res.status).toBe(200);
      expect(res.body.data.balance.amount).toBe(15000);
      expect(res.body.data.source).toBe('PROVIDER');
    });

    it('can read the local ledger without calling the provider', async () => {
      const { token } = await onboardFully();
      const res = await request(app).get(api('/accounts/balance?refresh=false')).set(auth(token));

      expect(res.status).toBe(200);
      expect(res.body.data.source).toBe('LEDGER');
    });

    it('404s for a customer with no account', async () => {
      const { token } = await register();
      const res = await request(app).get(api('/accounts/balance')).set(auth(token));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
    });
  });
});
