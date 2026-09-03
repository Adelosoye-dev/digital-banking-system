'use strict';

const { z } = require('zod');

// NUBAN is 10 digits, but provider-issued numbers may vary in length.
const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{10,20}$/, 'Account number must be 10 to 20 digits');

const nameEnquiryParams = z.object({ accountNumber }).strict();

const balanceQuery = z
  .object({
    refresh: z
      .enum(['true', 'false'])
      .optional()
      .default('true')
      .transform((v) => v === 'true'),
  })
  .strict();

module.exports = { accountNumber, nameEnquiryParams, balanceQuery };
