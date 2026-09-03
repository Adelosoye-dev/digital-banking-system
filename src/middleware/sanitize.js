'use strict';

/**
 * Strips Mongo operator keys ($gt, $ne, ...) and dotted paths out of anything
 * that arrives from a client, defeating query-selector injection such as
 * { "email": { "$ne": null } } against a login endpoint.
 *
 * Written by hand rather than pulled from express-mongo-sanitize because that
 * package mutates req.query, which is read-only from Express 5 onward.
 */

const MAX_DEPTH = 12;

function scrub(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = scrub(value[i], depth + 1);
    return value;
  }

  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor') {
      delete value[key];
      continue;
    }
    value[key] = scrub(value[key], depth + 1);
  }
  return value;
}

module.exports = function sanitize(req, _res, next) {
  if (req.body) scrub(req.body);
  if (req.params) scrub(req.params);
  // req.query is a getter in Express 5; scrub the object in place instead of reassigning.
  if (req.query) scrub(req.query);
  next();
};

module.exports.scrub = scrub;
