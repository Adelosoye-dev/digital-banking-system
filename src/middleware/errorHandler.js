'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

function notFound(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist on this API`));
}

/** Translates driver/library errors into ApiError before they reach the client. */
function normalise(err) {
  if (err instanceof ApiError) return err;

  // Mongoose schema validation
  if (err.name === 'ValidationError' && err.errors) {
    const details = Object.entries(err.errors).map(([field, e]) => ({ field, message: e.message }));
    return ApiError.unprocessable('Validation failed', { code: 'VALIDATION_ERROR', details, cause: err });
  }

  // Bad ObjectId in a path parameter
  if (err.name === 'CastError') {
    return ApiError.badRequest(`Invalid value for "${err.path}"`, { code: 'INVALID_IDENTIFIER', cause: err });
  }

  // Unique index violation
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {}).join(', ') || 'field';
    return ApiError.conflict(`A record with that ${field} already exists`, {
      code: 'DUPLICATE_KEY',
      details: { field },
      cause: err,
    });
  }

  // Malformed JSON body from body-parser
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return ApiError.badRequest('Request body is not valid JSON', { code: 'MALFORMED_JSON', cause: err });
  }

  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'Request body is too large', { code: 'PAYLOAD_TOO_LARGE', cause: err });
  }

  // Mongo is down / no primary available
  if (err.name === 'MongoNetworkError' || err.name === 'MongooseServerSelectionError') {
    return ApiError.unavailable('Database is temporarily unavailable', {
      code: 'DATABASE_UNAVAILABLE',
      cause: err,
      isOperational: false,
    });
  }

  return new ApiError(500, 'An unexpected error occurred', {
    code: 'INTERNAL_SERVER_ERROR',
    cause: err,
    isOperational: false,
  });
}

function errorHandler(err, req, res, _next) {
  const apiError = normalise(err);

  const logPayload = {
    err: { message: err.message, name: err.name, stack: err.stack },
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
    statusCode: apiError.statusCode,
    code: apiError.code,
    customerId: req.auth ? req.auth.customerId : undefined,
  };

  if (apiError.statusCode >= 500) logger.error(logPayload, 'Request failed');
  else logger.warn(logPayload, 'Request rejected');

  const body = {
    success: false,
    message: apiError.statusCode >= 500 && env.isProduction ? 'An unexpected error occurred' : apiError.message,
    code: apiError.code,
    requestId: req.id,
  };

  if (apiError.details) body.details = apiError.details;
  if (!env.isProduction && apiError.statusCode >= 500) body.stack = err.stack;

  res.status(apiError.statusCode).json(body);
}

module.exports = { errorHandler, notFound, normalise };
