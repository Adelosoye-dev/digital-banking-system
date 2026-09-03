'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

// Load .env from the project root regardless of the cwd the process was started in.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/api/v1'),

  // --- Our bank identity -------------------------------------------------
  BANK_NAME: z.string().min(2).default('Phoenix Trust Bank'),
  BANK_CODE: z.string().min(3).default('000001'),

  // --- Database ----------------------------------------------------------
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/digital_banking'),
  MONGODB_URI_TEST: z.string().optional(),

  // --- Auth --------------------------------------------------------------
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  JWT_REFRESH_SECRET: z.string().min(16).optional(),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  // --- NibssByPhoenix provider ------------------------------------------
  NIBSS_BASE_URL: z.string().url().default('https://nibssbyphoenix.onrender.com'),
  NIBSS_API_KEY: z.string().optional(),
  NIBSS_API_SECRET: z.string().optional(),
  NIBSS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Render free instances cold-start slowly; retry a few times on network errors.
  NIBSS_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  // Refresh the provider token this many seconds before it actually expires.
  NIBSS_TOKEN_SKEW_SECONDS: z.coerce.number().int().min(0).default(60),

  // --- Business rules ----------------------------------------------------
  OPENING_BALANCE_KOBO: z.coerce.number().int().min(0).default(1_500_000), // NGN 15,000.00
  MAX_ACCOUNTS_PER_CUSTOMER: z.coerce.number().int().min(1).default(1),
  MIN_TRANSFER_KOBO: z.coerce.number().int().min(1).default(100), // NGN 1.00
  MAX_TRANSFER_KOBO: z.coerce.number().int().min(1).default(100_000_000), // NGN 1,000,000.00
  NAME_ENQUIRY_TTL_SECONDS: z.coerce.number().int().min(0).default(900),

  // --- Ops ---------------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  CORS_ORIGIN: z.string().default('*'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const env = parsed.data;

env.isProduction = env.NODE_ENV === 'production';
env.isTest = env.NODE_ENV === 'test';
env.isDevelopment = env.NODE_ENV === 'development';

// In tests we never want to touch the real development database.
env.activeMongoUri = env.isTest
  ? env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/digital_banking_test'
  : env.MONGODB_URI;

env.corsOrigins = env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

module.exports = env;
