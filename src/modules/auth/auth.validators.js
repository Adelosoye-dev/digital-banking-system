'use strict';

const { z } = require('zod');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in yyyy-mm-dd format')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Date is not a real calendar date')
  .refine((v) => new Date(v) < new Date(), 'Date of birth must be in the past')
  .refine((v) => {
    const dob = new Date(v);
    const eighteen = new Date();
    eighteen.setFullYear(eighteen.getFullYear() - 18);
    return dob <= eighteen;
  }, 'Customer must be at least 18 years old');

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a digit');

// Accepts 08012345678, 2348012345678 or +2348012345678 and normalises to 0801...
const phone = z
  .string()
  .trim()
  .regex(/^(\+?234|0)[789]\d{9}$/, 'Enter a valid Nigerian phone number')
  .transform((v) => v.replace(/^\+?234/, '0'));

const name = z
  .string()
  .trim()
  .min(2, 'Must be at least 2 characters')
  .max(60, 'Must be at most 60 characters')
  .regex(/^[A-Za-z][A-Za-z'\-\s]*$/, 'Only letters, spaces, hyphens and apostrophes are allowed');

const registerSchema = z
  .object({
    firstName: name,
    lastName: name,
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    phone,
    dateOfBirth: isoDate,
    password,
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z.string().min(1, 'Password is required'),
  })
  .strict();

const refreshSchema = z.object({ refreshToken: z.string().min(10, 'refreshToken is required') }).strict();

const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: password })
  .strict()
  .refine((d) => d.currentPassword !== d.newPassword, {
    message: 'New password must be different from the current one',
    path: ['newPassword'],
  });

module.exports = { registerSchema, loginSchema, refreshSchema, changePasswordSchema, isoDate, password, phone, name };
