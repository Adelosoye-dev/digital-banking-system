'use strict';

const { app, api, request, onboardFully, auth } = require('./helpers');
const fakeProvider = require('./fakeProvider');
const { Account } = require('../src/models');

describe('Core banking operations', () => {
  describe('name enquiry', () => {
    it('resolves an account inside this bank as INTRA_BANK', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const res = await request(app)
        .get(api(`/accounts/name-enquiry/${bob.account.accountNumber}`))
        .set(auth(alice.token));

      expect(res.status).toBe(200);
      expect(res.body.data.transferType).toBe('INTRA_BANK');
      expect(res.body.data.accountName).toBe(bob.account.accountName);
    });

    it('resolves an account outside this bank as INTER_BANK', async () => {
      const alice = await onboardFully();
      fakeProvider.seedExternalAccount('9988776655', 'COLLEAGUE CUSTOMER');

      const res = await request(app).get(api('/accounts/name-enquiry/9988776655')).set(auth(alice.token));

      expect(res.status).toBe(200);
      expect(res.body.data.transferType).toBe('INTER_BANK');
      expect(res.body.data.accountName).toBe('COLLEAGUE CUSTOMER');
    });

    it('never exposes the balance or owner of the resolved account', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const res = await request(app)
        .get(api(`/accounts/name-enquiry/${bob.account.accountNumber}`))
        .set(auth(alice.token));

      expect(res.body.data.balance).toBeUndefined();
      expect(res.body.data.customer).toBeUndefined();
      expect(res.body.data.id).toBeUndefined();
    });

    it('rejects an enquiry against your own account', async () => {
      const alice = await onboardFully();
      const res = await request(app)
        .get(api(`/accounts/name-enquiry/${alice.account.accountNumber}`))
        .set(auth(alice.token));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SELF_ENQUIRY');
    });

    it('404s for an account nobody has', async () => {
      const alice = await onboardFully();
      const res = await request(app).get(api('/accounts/name-enquiry/0000000000')).set(auth(alice.token));
      expect(res.status).toBe(404);
    });
  });

  describe('intra-bank transfer', () => {
    it('debits the sender and credits the beneficiary', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 2500, narration: 'Lunch' });

      expect(res.status).toBe(201);
      expect(res.body.data.transaction.status).toBe('SUCCESS');
      expect(res.body.data.transaction.type).toBe('INTRA_BANK_TRANSFER');
      expect(res.body.data.transaction.direction).toBe('DEBIT');
      expect(res.body.data.balance.amount).toBe(12500);
      expect(res.body.data.beneficiaryCredited).toBe(true);

      const bobBalance = await request(app).get(api('/accounts/balance?refresh=false')).set(auth(bob.token));
      expect(bobBalance.body.data.balance.amount).toBe(17500);
    });

    it('gives the beneficiary a matching CREDIT entry in their own history', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 1000, narration: 'Split bill' });

      const res = await request(app).get(api('/transactions?direction=CREDIT')).set(auth(bob.token));
      const credit = res.body.data.find((t) => t.type === 'INTRA_BANK_TRANSFER');

      expect(credit).toBeDefined();
      expect(credit.direction).toBe('CREDIT');
      expect(credit.amount.amount).toBe(1000);
      expect(credit.narration).toBe('Split bill');
      expect(credit.source.accountNumber).toBe(alice.account.accountNumber);
    });

    it('records balanceBefore and balanceAfter on the debit leg', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 500 });

      expect(res.body.data.transaction.balanceBefore.amount).toBe(15000);
      expect(res.body.data.transaction.balanceAfter.amount).toBe(14500);
    });

    it('handles kobo precision without float drift', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 1.1 });
      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 2.2 });

      // 1.10 + 2.20 is exactly 330 kobo - no 3.3000000000000003 drift.
      expect(res.body.data.balance.amountInKobo).toBe(1500000 - 110 - 220);
    });
  });

  describe('inter-bank transfer', () => {
    it('routes an unknown account out through the provider', async () => {
      const alice = await onboardFully();
      fakeProvider.seedExternalAccount('9988776655', 'COLLEAGUE CUSTOMER');

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: '9988776655', amount: 3000, narration: 'Inter-bank test' });

      expect(res.status).toBe(201);
      expect(res.body.data.transaction.type).toBe('INTER_BANK_TRANSFER');
      expect(res.body.data.beneficiaryCredited).toBe(false);
      expect(res.body.data.balance.amount).toBe(12000);
      expect(fakeProvider.state.accounts.get('9988776655').balance).toBe(3000);
    });
  });

  describe('guard rails', () => {
    it('rejects a transfer that exceeds the balance and leaves it untouched', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 20000 });

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('INSUFFICIENT_FUNDS');

      const account = await Account.findOne({ accountNumber: alice.account.accountNumber });
      expect(account.balance).toBe(1500000);
      expect(account.lockedBalance).toBe(0);
    });

    it('rejects a transfer to your own account', async () => {
      const alice = await onboardFully();
      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: alice.account.accountNumber, amount: 100 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SELF_TRANSFER');
    });

    it('rejects a zero or negative amount', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      for (const amount of [0, -50]) {
        const res = await request(app)
          .post(api('/transfers'))
          .set(auth(alice.token))
          .send({ destinationAccountNumber: bob.account.accountNumber, amount });
        expect(res.status).toBe(422);
      }
    });

    it('rejects more than two decimal places', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 10.123 });

      expect(res.status).toBe(422);
    });

    it('refuses a transfer from a customer with no account', async () => {
      const { register } = require('./helpers');
      const noAccount = await register();
      const bob = await onboardFully();

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(noAccount.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 100 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('KYC_REQUIRED');
    });

    it('releases the reservation when the provider declines', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });
      fakeProvider.state.failNextTransfer = 'DECLINE';

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 1000 });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TRANSFER_DECLINED');

      const account = await Account.findOne({ accountNumber: alice.account.accountNumber });
      expect(account.balance).toBe(1500000);
      expect(account.lockedBalance).toBe(0);
    });

    it('holds the funds when the provider outcome is unknown', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });
      fakeProvider.state.failNextTransfer = 'UNREACHABLE';

      const res = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 1000 });

      expect(res.status).toBe(202);
      expect(res.body.data.transaction.status).toBe('PROCESSING');

      // Balance is intact but the amount is locked, so it cannot be spent twice.
      const account = await Account.findOne({ accountNumber: alice.account.accountNumber });
      expect(account.balance).toBe(1500000);
      expect(account.lockedBalance).toBe(100000);
    });
  });

  describe('idempotency', () => {
    it('returns the original transaction when the same key is replayed', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });
      const body = { destinationAccountNumber: bob.account.accountNumber, amount: 1000, idempotencyKey: 'key-abc-123' };

      const first = await request(app).post(api('/transfers')).set(auth(alice.token)).send(body);
      const second = await request(app).post(api('/transfers')).set(auth(alice.token)).send(body);

      expect(first.status).toBe(201);
      expect(second.body.data.replayed).toBe(true);
      expect(second.body.data.transaction.reference).toBe(first.body.data.transaction.reference);

      const account = await Account.findOne({ accountNumber: alice.account.accountNumber });
      expect(account.balance).toBe(1500000 - 100000);
    });

    it('accepts the key from the Idempotency-Key header', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });
      const body = { destinationAccountNumber: bob.account.accountNumber, amount: 1000 };

      const first = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .set('Idempotency-Key', 'header-key-1234')
        .send(body);
      const second = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .set('Idempotency-Key', 'header-key-1234')
        .send(body);

      expect(first.status).toBe(201);
      expect(second.body.data.replayed).toBe(true);
    });
  });

  describe('transaction status check', () => {
    it('returns the status of your own transaction', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });

      const transfer = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 750 });

      const res = await request(app)
        .get(api(`/transactions/${transfer.body.data.transaction.reference}`))
        .set(auth(alice.token));

      expect(res.status).toBe(200);
      expect(res.body.data.transaction.status).toBe('SUCCESS');
    });

    it('settles a held transfer once the provider confirms it', async () => {
      const alice = await onboardFully();
      const bob = await onboardFully({ kyc: 'nin' });
      fakeProvider.state.failNextTransfer = 'PENDING';

      const transfer = await request(app)
        .post(api('/transfers'))
        .set(auth(alice.token))
        .send({ destinationAccountNumber: bob.account.accountNumber, amount: 1200 });

      const { reference } = transfer.body.data.transaction;
      expect(transfer.body.data.transaction.status).toBe('PROCESSING');

      // The provider now reports success.
      const providerRef = transfer.body.data.transaction.reference;
      const record = [...fakeProvider.state.transactions.values()].at(-1);
      record.status = 'SUCCESS';

      const res = await request(app).get(api(`/transactions/${reference}`)).set(auth(alice.token));

      expect(res.body.data.transaction.status).toBe('SUCCESS');
      expect(providerRef).toBe(reference);

      const account = await Account.findOne({ accountNumber: alice.account.accountNumber });
      expect(account.balance).toBe(1500000 - 120000);
      expect(account.lockedBalance).toBe(0);
    });
  });
});
