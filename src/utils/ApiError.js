'use strict';

/**
 * Operational (expected) error. Anything thrown that is NOT an ApiError is
 * treated as a bug and surfaced as a generic 500.
 */
class ApiError extends Error {
  constructor(statusCode, message, { code, details, cause, isOperational = true } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || ApiError.defaultCode(statusCode);
    this.details = details;
    this.isOperational = isOperational;
    if (cause) this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }

  static defaultCode(status) {
    return (
      {
        400: 'BAD_REQUEST',
        401: 'UNAUTHORIZED',
        402: 'PAYMENT_REQUIRED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        422: 'UNPROCESSABLE_ENTITY',
        429: 'TOO_MANY_REQUESTS',
        502: 'BAD_GATEWAY',
        503: 'SERVICE_UNAVAILABLE',
        504: 'GATEWAY_TIMEOUT',
      }[status] || 'INTERNAL_SERVER_ERROR'
    );
  }

  static badRequest(msg = 'Bad request', opts) { return new ApiError(400, msg, opts); }
  static unauthorized(msg = 'Authentication required', opts) { return new ApiError(401, msg, opts); }
  static forbidden(msg = 'You do not have access to this resource', opts) { return new ApiError(403, msg, opts); }
  static notFound(msg = 'Resource not found', opts) { return new ApiError(404, msg, opts); }
  static conflict(msg = 'Conflict', opts) { return new ApiError(409, msg, opts); }
  static unprocessable(msg = 'Unprocessable entity', opts) { return new ApiError(422, msg, opts); }
  static tooMany(msg = 'Too many requests', opts) { return new ApiError(429, msg, opts); }
  static badGateway(msg = 'Upstream provider error', opts) { return new ApiError(502, msg, opts); }
  static unavailable(msg = 'Service temporarily unavailable', opts) { return new ApiError(503, msg, opts); }
}

module.exports = ApiError;
