'use strict';

const { z } = require('zod');
const { accountNumber } = require('../accounts/accounts.validators');

const transferSchema = z
  .object({
    destinationAccountNumber: accountNumber,
    // Naira, at most 2 decimal places. Kobo conversion happens in the service.
    amount: z
      .number({ invalid_type_error: 'Amount must be a number' })
      .positive('Amount must be greater than zero')
      .refine((v) => Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
        message: 'Amount may have at most 2 decimal places',
      }),
    narration: z.string().trim().max(140, 'Narration must be at most 140 characters').optional().default(''),
    // Optional caller-supplied key that makes a retry safe.
    idempotencyKey: z.string().trim().min(8).max(64).optional(),
  })
  .strict();

module.exports = { transferSchema };
