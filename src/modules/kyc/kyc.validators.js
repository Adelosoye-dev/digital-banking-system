'use strict';

const { z } = require('zod');
const { isoDate, name, phone } = require('../auth/auth.validators');

/**
 * BVN and NIN are both 11 digits.
 *
 * These endpoints deliberately let the caller OMIT the identifier: the service
 * then mints a synthetic 11-digit test identifier. Real BVNs and NINs are not
 * permitted in this exercise, and generating them removes any temptation.
 */
const elevenDigits = z
  .string()
  .trim()
  .regex(/^\d{11}$/, 'Must be exactly 11 digits');

const createBvnSchema = z
  .object({
    bvn: elevenDigits.optional(),
    firstName: name.optional(),
    lastName: name.optional(),
    dateOfBirth: isoDate.optional(),
    phone: phone.optional(),
  })
  .strict();

const createNinSchema = z
  .object({
    nin: elevenDigits.optional(),
    firstName: name.optional(),
    lastName: name.optional(),
    dateOfBirth: isoDate.optional(),
  })
  .strict();

/** Attaches an identifier that already exists at the provider. */
const verifySchema = z
  .object({
    type: z.enum(['BVN', 'NIN']),
    identifier: elevenDigits,
  })
  .strict();

module.exports = { createBvnSchema, createNinSchema, verifySchema, elevenDigits };
