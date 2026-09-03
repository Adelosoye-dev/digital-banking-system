'use strict';

/**
 * All internal amounts are stored as integer KOBO to avoid float drift.
 * The NibssByPhoenix API speaks NAIRA, so every outbound/inbound amount is
 * converted at the integration boundary - never in business logic.
 */

const KOBO_PER_NAIRA = 100;

function nairaToKobo(naira) {
  const n = Number(naira);
  if (!Number.isFinite(n)) throw new TypeError(`Cannot convert "${naira}" to kobo`);
  // Round through a string to dodge 0.1 + 0.2 style binary artefacts.
  return Math.round(Number(n.toFixed(2)) * KOBO_PER_NAIRA);
}

function koboToNaira(kobo) {
  const k = Number(kobo);
  if (!Number.isFinite(k)) throw new TypeError(`Cannot convert "${kobo}" to naira`);
  return Number((k / KOBO_PER_NAIRA).toFixed(2));
}

function formatNaira(kobo) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
  }).format(koboToNaira(kobo));
}

/** Shape used everywhere an amount is returned to a client. */
function money(kobo) {
  return {
    amount: koboToNaira(kobo),
    amountInKobo: Number(kobo),
    currency: 'NGN',
    formatted: formatNaira(kobo),
  };
}

module.exports = { KOBO_PER_NAIRA, nairaToKobo, koboToNaira, formatNaira, money };
