'use strict';

const { app, api, request, register, onboardFully, auth } = require('./helpers');

/**
 * Requirement 4 of the brief: each customer sees only their own data, and no
 * customer can reach another customer records.
 */
describe('Data privacy and isolation', () => {
  async function twoCustomersWithATransfer() {
    const alice = await onboardFully();
    const bob = await onboardFully({ kyc: 'nin' });

    const transfer = await request(app)
      .post(api('/transfers'))
      .set(auth(alice.token))
      .send({ destinationAccountNumber: bob.account.accountNumber, amount: 1500, narration: 'Shared cost' });

    return { alice, bob, reference: transfer.body.data.transaction.reference };
  }

  it('shows each customer only their own transactions', async () => {
    const { alice, bob } = await twoCustomersWithATransfer();

    const aliceHistory = await request(app).get(api('/transactions')).set(auth(alice.token));
    const bobHistory = await request(app).get(api('/transactions')).set(auth(bob.token));

    // Alice: opening credit + her debit. Bob: opening credit + his credit.
    expect(aliceHistory.body.data.every((t) => t.direction === 'CREDIT' || t.direction === 'DEBIT')).toBe(true);
    expect(aliceHistory.body.data.filter((t) => t.direction === 'DEBIT')).toHaveLength(1);
    expect(bobHistory.body.data.filter((t) => t.direction === 'DEBIT')).toHaveLength(0);

    const aliceRefs = aliceHistory.body.data.map((t) => t.reference);
    const bobRefs = bobHistory.body.data.map((t) => t.reference);
    expect(aliceRefs.some((r) => bobRefs.includes(r))).toBe(false);
  });

  it('404s when one customer requests another transaction reference', async () => {
    const { bob, reference } = await twoCustomersWithATransfer();

    const res = await request(app).get(api(`/transactions/${reference}`)).set(auth(bob.token));

    // 404, not 403 - the response must not confirm that the reference exists.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
  });

  it('scopes the summary to the caller', async () => {
    const { alice, bob } = await twoCustomersWithATransfer();

    const aliceSummary = await request(app).get(api('/transactions/summary')).set(auth(alice.token));
    const bobSummary = await request(app).get(api('/transactions/summary')).set(auth(bob.token));

    expect(aliceSummary.body.data.totalDebited.amount).toBe(1500);
    expect(bobSummary.body.data.totalDebited.amount).toBe(0);
    expect(bobSummary.body.data.totalCredited.amount).toBe(16500);
  });

  it('returns only the caller own account from /accounts/me', async () => {
    const alice = await onboardFully();
    const bob = await onboardFully({ kyc: 'nin' });

    const res = await request(app).get(api('/accounts/me')).set(auth(alice.token));

    expect(res.body.data.accountNumber).toBe(alice.account.accountNumber);
    expect(res.body.data.accountNumber).not.toBe(bob.account.accountNumber);
  });

  it('rejects every protected route without a token', async () => {
    const routes = [
      ['get', '/auth/me'],
      ['get', '/kyc/status'],
      ['post', '/kyc/bvn'],
      ['post', '/accounts'],
      ['get', '/accounts/me'],
      ['get', '/accounts/balance'],
      ['post', '/transfers'],
      ['get', '/transactions'],
      ['get', '/transactions/summary'],
    ];

    for (const [method, path] of routes) {
      const res = await request(app)[method](api(path)).send({});
      expect([401, 403]).toContain(res.status);
    }
  });

  it('rejects a tampered or forged token', async () => {
    const { token } = await onboardFully();
    const tampered = `${token.slice(0, -4)}AAAA`;

    const res = await request(app).get(api('/auth/me')).set(auth(tampered));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('revokes existing sessions when the password changes', async () => {
    const { token, payload } = await onboardFully();

    const change = await request(app)
      .post(api('/auth/change-password'))
      .set(auth(token))
      .send({ currentPassword: payload.password, newPassword: 'BrandNewPass9' });
    expect(change.status).toBe(200);

    const oldToken = await request(app).get(api('/auth/me')).set(auth(token));
    expect(oldToken.status).toBe(401);
    expect(oldToken.body.code).toBe('TOKEN_REVOKED');

    const newToken = await request(app).get(api('/auth/me')).set(auth(change.body.data.tokens.accessToken));
    expect(newToken.status).toBe(200);
  });

  it('resists mongo operator injection on login', async () => {
    const { payload } = await register();

    const res = await request(app)
      .post(api('/auth/login'))
      .send({ email: { $ne: null }, password: { $ne: null } });

    expect([401, 422]).toContain(res.status);
    expect(res.body.success).toBe(false);

    // The real credentials still work, so the sanitiser did not break login.
    const good = await request(app)
      .post(api('/auth/login'))
      .send({ email: payload.email, password: payload.password });
    expect(good.status).toBe(200);
  });

  it('filters history by direction, type and amount without crossing customers', async () => {
    const { alice } = await twoCustomersWithATransfer();

    const debits = await request(app).get(api('/transactions?direction=DEBIT')).set(auth(alice.token));
    expect(debits.body.data).toHaveLength(1);
    expect(debits.body.meta.total).toBe(1);

    const large = await request(app).get(api('/transactions?minAmount=10000')).set(auth(alice.token));
    expect(large.body.data.every((t) => t.amount.amount >= 10000)).toBe(true);

    const opening = await request(app).get(api('/transactions?type=OPENING_CREDIT')).set(auth(alice.token));
    expect(opening.body.data).toHaveLength(1);
  });

  it('paginates history', async () => {
    const { alice } = await twoCustomersWithATransfer();

    const res = await request(app).get(api('/transactions?page=1&limit=1')).set(auth(alice.token));

    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true });
  });
});
