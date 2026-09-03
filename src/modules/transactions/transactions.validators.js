'use strict';

const { z } = require('zod');
const { TXN_STATUS, TXN_TYPE, TXN_DIRECTION } = require('../../models/constants');

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd');

const historyQuery = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(Object.values(TXN_STATUS)).optional(),
    type: z.enum(Object.values(TXN_TYPE)).optional(),
    direction: z.enum(Object.values(TXN_DIRECTION)).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    minAmount: z.coerce.number().nonnegative().optional(),
    maxAmount: z.coerce.number().nonnegative().optional(),
    search: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: 'from must be on or before to',
    path: ['from'],
  })
  .refine((q) => q.minAmount === undefined || q.maxAmount === undefined || q.minAmount <= q.maxAmount, {
    message: 'minAmount must not exceed maxAmount',
    path: ['minAmount'],
  });

const referenceParams = z
  .object({
    reference: z
      .string()
      .trim()
      .min(6, 'Reference is too short')
      .max(64, 'Reference is too long')
      .regex(/^[A-Za-z0-9_-]+$/, 'Reference contains invalid characters'),
  })
  .strict();

const refreshQuery = z
  .object({
    refresh: z
      .enum(['true', 'false'])
      .optional()
      .default('true')
      .transform((v) => v === 'true'),
  })
  .strict();

module.exports = { historyQuery, referenceParams, refreshQuery };
