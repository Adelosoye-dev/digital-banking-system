'use strict';

const { randomUUID } = require('crypto');

/** Correlates logs, responses and provider calls for a single inbound request. */
module.exports = function requestId(req, res, next) {
  const incoming = req.get('X-Request-Id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};
