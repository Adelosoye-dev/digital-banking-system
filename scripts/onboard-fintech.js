#!/usr/bin/env node
'use strict';

/**
 * One-time fintech onboarding with NibssByPhoenix.
 *
 *   npm run onboard -- --name "Phoenix Trust Bank" --email you@example.com
 *
 * NibssByPhoenix emails the API key and secret to the address you supply.
 * Paste them into .env as NIBSS_API_KEY and NIBSS_API_SECRET, then restart.
 *
 * This is the only script that talks to the provider without credentials.
 */

const env = require('../src/config/env');
const nibss = require('../src/integrations/nibss/nibss.service');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.name || process.env.BANK_NAME || env.BANK_NAME;
  const email = args.email || process.env.ONBOARDING_EMAIL;

  if (!email) {
    console.error(
      [
        '',
        'An email address is required - it is where NibssByPhoenix sends your API credentials.',
        '',
        '  npm run onboard -- --name "Your Bank Name" --email you@example.com',
        '',
      ].join('\n')
    );
    process.exit(1);
  }

  console.log('');
  console.log('  Onboarding with NibssByPhoenix');
  console.log(`    endpoint : ${env.NIBSS_BASE_URL}/api/fintech/onboard`);
  console.log(`    bank     : ${name}`);
  console.log(`    email    : ${email}`);
  console.log('');
  console.log('  This registers your bank and emails API credentials to that address.');
  console.log('  Contacting the provider (Render cold starts can take ~30s)...');
  console.log('');

  try {
    const { raw } = await nibss.onboardFintech({ name, email });
    console.log('  Provider response:');
    console.log(JSON.stringify(raw, null, 2).replace(/^/gm, '    '));
    console.log('');
    console.log('  Next: copy the apiKey and apiSecret from your inbox into .env');
    console.log('        NIBSS_API_KEY=...');
    console.log('        NIBSS_API_SECRET=...');
    console.log('  Then verify with: curl http://localhost:4000/api/v1/health/provider');
    console.log('');
    process.exit(0);
  } catch (err) {
    console.error(`  Onboarding failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2).replace(/^/gm, '    '));
    process.exit(1);
  }
}

main();
