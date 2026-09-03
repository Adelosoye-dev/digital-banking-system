'use strict';

const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Crockford-ish: no I or O.

function randomChars(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Human-quotable, sortable-ish transaction reference, e.g. TRX-LZ4K9Q-8F2XQW. */
function transactionReference(prefix = 'TRX') {
  const stamp = Date.now().toString(36).toUpperCase();
  return `${prefix}-${stamp}-${randomChars(6)}`;
}

function randomDigits(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += crypto.randomInt(0, 10).toString();
  return out;
}

function sessionId() {
  // 30 digits, mirroring the NIBSS session-ID shape: 12 from the clock, 18 random.
  // Built from single digits because crypto.randomInt caps out below 1e17.
  return `${Date.now()}`.padEnd(12, '0').slice(0, 12) + randomDigits(18);
}

/** 11-digit synthetic BVN/NIN for test onboarding. Never a real identity. */
function syntheticKycId() {
  let id = crypto.randomInt(1, 10).toString(); // never leading zero
  for (let i = 0; i < 10; i += 1) id += crypto.randomInt(0, 10).toString();
  return id;
}

module.exports = { transactionReference, sessionId, syntheticKycId, randomChars, randomDigits };
