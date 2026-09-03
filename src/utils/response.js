'use strict';

function ok(res, data, { message = 'Success', status = 200, meta } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  if (res.locals.requestId) body.requestId = res.locals.requestId;
  return res.status(status).json(body);
}

function created(res, data, message = 'Created') {
  return ok(res, data, { message, status: 201 });
}

function paginated(res, items, { page, limit, total, message = 'Success' }) {
  return ok(res, items, {
    message,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  });
}

module.exports = { ok, created, paginated };
