'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Validates and REPLACES req.body / req.params / req.query with the parsed
 * result, so handlers only ever see coerced, stripped, trusted data.
 *
 * Express 5 makes req.query a getter, so the parsed query is exposed on
 * req.validatedQuery instead of being reassigned.
 */
module.exports = function validate(schemas) {
  return (req, _res, next) => {
    const issues = [];

    for (const source of ['body', 'params', 'query']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            field: [source, ...issue.path].join('.').replace(/^body\./, ''),
            message: issue.message,
            code: issue.code,
          });
        }
        continue;
      }

      if (source === 'query') {
        req.validatedQuery = result.data;
      } else {
        req[source] = result.data;
      }
    }

    if (issues.length) {
      return next(ApiError.unprocessable('Validation failed', { code: 'VALIDATION_ERROR', details: issues }));
    }
    return next();
  };
};
