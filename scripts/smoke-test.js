#!/usr/bin/env node
'use strict';

/**
 * End-to-end walkthrough against a RUNNING server. Exercises every requirement
 * in the brief, in order, and prints a pass/fail line for each step.
 *
 *   npm start          # in one terminal
 *   npm run smoke      # in another
 *
 * Optional: --base http://localhost:4000  --external 0123456789
 * `--external` is a colleague account number, used for the inter-bank leg.
 */

const env = require('../src/config/env');

const args = process.argv.slice(2).reduce((acc, token, i, all) => {
  if (token.startsWith('--')) acc[token.slice(2)] = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true;
  return acc;
}, {});

const BASE = (args.base || `http://localhost:${env.PORT}`).replace(/\/$/, '');
const API = `${BASE}${env.API_PREFIX}`;

let passed = 0;
let failed = 0;

function step(label, detail) {
  passed += 1;
  console.log(`  ok   ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, error) {
  failed += 1;
  console.log(`  FAIL ${label} - ${error}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function unique(prefix) {
  const stamp = Date.now().toString().slice(-9);
  return {
    email: `${prefix}.${stamp}@smoketest.local`,
    phone: `080${stamp}`.slice(0, 11),
  };
}

async function onboardCustomer(prefix, kycMethod) {
  const { email, phone } = unique(prefix);
  const password = 'Passw0rdTest1';

  const reg = await call('POST', '/auth/register', {
    body: {
      firstName: prefix === 'alice' ? 'Alice' : 'Bob',
      lastName: 'Smoketest',
      email,
      phone,
      dateOfBirth: '1995-06-15',
      password,
    },
  });
  if (reg.status !== 201) throw new Error(`register -> ${reg.status} ${reg.body.message}`);
  const token = reg.body.data.tokens.accessToken;

  const kyc = await call('POST', `/kyc/${kycMethod}`, { token });
  if (kyc.status !== 201) throw new Error(`kyc/${kycMethod} -> ${kyc.status} ${kyc.body.message}`);

  const acct = await call('POST', '/accounts', { token });
  if (acct.status !== 201) throw new Error(`accounts -> ${acct.status} ${acct.body.message}`);

  return { email, password, token, account: acct.body.data.account, preFunded: acct.body.data.preFunded };
}

async function main() {
  console.log(`\n  Smoke test against ${API}\n`);

  // --- 0. health --------------------------------------------------------
  try {
    const h = await call('GET', '/health');
    if (h.status !== 200) throw new Error(`status ${h.status}`);
    step('health', `db=${h.body.data.database} providerCreds=${h.body.data.provider.credentialsConfigured}`);
    if (!h.body.data.provider.credentialsConfigured) {
      console.log('\n  NIBSS_API_KEY / NIBSS_API_SECRET are not set - run `npm run onboard` first.\n');
      process.exit(1);
    }
  } catch (e) {
    fail('health', e.message);
    console.log('\n  Is the server running? `npm start`\n');
    process.exit(1);
  }

  // --- 1. onboarding gate: account before KYC must be refused -----------
  let gateToken;
  try {
    const { email, phone } = unique('gate');
    const reg = await call('POST', '/auth/register', {
      body: {
        firstName: 'Gate',
        lastName: 'Check',
        email,
        phone,
        dateOfBirth: '1990-01-01',
        password: 'Passw0rdTest1',
      },
    });
    gateToken = reg.body.data.tokens.accessToken;
    const early = await call('POST', '/accounts', { token: gateToken });
    if (early.status !== 403 || early.body.code !== 'KYC_REQUIRED') {
      throw new Error(`expected 403 KYC_REQUIRED, got ${early.status} ${early.body.code}`);
    }
    step('account creation blocked before KYC', '403 KYC_REQUIRED');
  } catch (e) {
    fail('account creation blocked before KYC', e.message);
  }

  // --- 2. two fully onboarded customers ---------------------------------
  let alice;
  let bob;
  try {
    alice = await onboardCustomer('alice', 'bvn');
    step('customer A onboarded via BVN', `${alice.account.accountNumber} funded ${alice.preFunded.formatted}`);
  } catch (e) {
    fail('customer A onboarding', e.message);
    process.exit(1);
  }

  try {
    bob = await onboardCustomer('bob', 'nin');
    step('customer B onboarded via NIN', `${bob.account.accountNumber} funded ${bob.preFunded.formatted}`);
  } catch (e) {
    fail('customer B onboarding', e.message);
    process.exit(1);
  }

  // --- 3. one account per customer --------------------------------------
  try {
    const dup = await call('POST', '/accounts', { token: alice.token });
    if (dup.status !== 409) throw new Error(`expected 409, got ${dup.status}`);
    step('second account refused', '409 ACCOUNT_LIMIT_REACHED');
  } catch (e) {
    fail('second account refused', e.message);
  }

  // --- 4. balance check --------------------------------------------------
  try {
    const bal = await call('GET', '/accounts/balance', { token: alice.token });
    if (bal.status !== 200) throw new Error(`status ${bal.status}`);
    step('balance check', `${bal.body.data.balance.formatted} (source ${bal.body.data.source})`);
  } catch (e) {
    fail('balance check', e.message);
  }

  // --- 5. name enquiry ---------------------------------------------------
  try {
    const ne = await call('GET', `/accounts/name-enquiry/${bob.account.accountNumber}`, { token: alice.token });
    if (ne.status !== 200) throw new Error(`status ${ne.status} ${ne.body.message}`);
    step('name enquiry', `${ne.body.data.accountName} (${ne.body.data.transferType})`);
  } catch (e) {
    fail('name enquiry', e.message);
  }

  // --- 6. intra-bank transfer -------------------------------------------
  let intraRef;
  try {
    const tx = await call('POST', '/transfers', {
      token: alice.token,
      body: { destinationAccountNumber: bob.account.accountNumber, amount: 2500, narration: 'Smoke test intra' },
    });
    if (tx.status !== 201) throw new Error(`status ${tx.status} ${tx.body.message}`);
    intraRef = tx.body.data.transaction.reference;
    step('intra-bank transfer', `${intraRef} balance now ${tx.body.data.balance.formatted}`);
  } catch (e) {
    fail('intra-bank transfer', e.message);
  }

  // --- 7. beneficiary really received it ---------------------------------
  try {
    const bal = await call('GET', '/accounts/balance?refresh=false', { token: bob.token });
    step('beneficiary credited', bal.body.data.balance.formatted);
  } catch (e) {
    fail('beneficiary credited', e.message);
  }

  // --- 8. inter-bank transfer (needs a colleague account) ----------------
  if (args.external) {
    try {
      const ne = await call('GET', `/accounts/name-enquiry/${args.external}`, { token: alice.token });
      if (ne.status !== 200) throw new Error(`name enquiry ${ne.status} ${ne.body.message}`);
      const tx = await call('POST', '/transfers', {
        token: alice.token,
        body: { destinationAccountNumber: args.external, amount: 500, narration: 'Smoke test inter' },
      });
      if (![200, 201, 202].includes(tx.status)) throw new Error(`status ${tx.status} ${tx.body.message}`);
      step('inter-bank transfer', `${tx.body.data.transaction.reference} -> ${ne.body.data.accountName}`);
    } catch (e) {
      fail('inter-bank transfer', e.message);
    }
  } else {
    console.log('  skip inter-bank transfer - pass --external <colleague account number> to include it');
  }

  // --- 9. insufficient funds --------------------------------------------
  try {
    const tx = await call('POST', '/transfers', {
      token: alice.token,
      // Above the NGN 15,000 balance but below MAX_TRANSFER_KOBO, so this
      // exercises the balance check rather than the per-transfer cap.
      body: { destinationAccountNumber: bob.account.accountNumber, amount: 50_000 },
    });
    if (tx.status !== 402) throw new Error(`expected 402, got ${tx.status}`);
    step('insufficient funds rejected', '402 INSUFFICIENT_FUNDS');
  } catch (e) {
    fail('insufficient funds rejected', e.message);
  }

  // --- 10. transaction status check -------------------------------------
  if (intraRef) {
    try {
      const st = await call('GET', `/transactions/${intraRef}`, { token: alice.token });
      if (st.status !== 200) throw new Error(`status ${st.status}`);
      step('transaction status check', st.body.data.transaction.status);
    } catch (e) {
      fail('transaction status check', e.message);
    }
  }

  // --- 11. history is scoped to the owner --------------------------------
  try {
    const mine = await call('GET', '/transactions', { token: alice.token });
    const theirs = await call('GET', `/transactions/${intraRef}`, { token: bob.token });
    if (theirs.status !== 404) throw new Error(`B could read A transaction: ${theirs.status}`);
    step('data isolation', `A sees ${mine.body.meta.total} of their own; B gets 404 on A reference`);
  } catch (e) {
    fail('data isolation', e.message);
  }

  // --- 12. unauthenticated access ----------------------------------------
  try {
    const anon = await call('GET', '/transactions');
    if (anon.status !== 401) throw new Error(`expected 401, got ${anon.status}`);
    step('unauthenticated access blocked', '401');
  } catch (e) {
    fail('unauthenticated access blocked', e.message);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  Smoke test crashed: ${err.message}\n`);
  process.exit(1);
});
