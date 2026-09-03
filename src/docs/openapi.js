'use strict';

const env = require('../config/env');
const pkg = require('../../package.json');

const bearer = [{ bearerAuth: [] }];

const money = {
  type: 'object',
  properties: {
    amount: { type: 'number', example: 15000 },
    amountInKobo: { type: 'integer', example: 1500000 },
    currency: { type: 'string', example: 'NGN' },
    formatted: { type: 'string', example: '₦15,000.00' },
  },
};

const envelope = (dataSchema, message = 'Success') => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    message: { type: 'string', example: message },
    data: dataSchema,
    requestId: { type: 'string', format: 'uuid' },
  },
});

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    message: { type: 'string', example: 'Validation failed' },
    code: { type: 'string', example: 'VALIDATION_ERROR' },
    requestId: { type: 'string', format: 'uuid' },
    details: { type: 'array', items: { type: 'object' } },
  },
};

const err = (description) => ({ description, content: { 'application/json': { schema: errorResponse } } });
const okResp = (description, schema) => ({
  description,
  content: { 'application/json': { schema: envelope(schema, description) } },
});

const accountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    accountNumber: { type: 'string', example: '0123456789' },
    accountName: { type: 'string', example: 'JOHN DOE' },
    bankName: { type: 'string' },
    bankCode: { type: 'string' },
    status: { type: 'string', enum: ['ACTIVE', 'DORMANT', 'FROZEN', 'CLOSED'] },
    balance: money,
    availableBalance: money,
    lockedBalance: money,
    openedAt: { type: 'string', format: 'date-time' },
  },
};

const transactionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    reference: { type: 'string', example: 'TRX-LZ4K9Q-8F2XQW' },
    groupReference: { type: 'string' },
    sessionId: { type: 'string' },
    type: {
      type: 'string',
      enum: ['OPENING_CREDIT', 'INTRA_BANK_TRANSFER', 'INTER_BANK_TRANSFER'],
    },
    direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
    status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED'] },
    amount: money,
    balanceBefore: money,
    balanceAfter: money,
    source: { type: 'object' },
    destination: { type: 'object' },
    narration: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time' },
  },
};

const p = (path) => `${env.API_PREFIX}${path}`;

module.exports = {
  openapi: '3.0.3',
  info: {
    title: `${env.BANK_NAME} - Core Banking API`,
    version: pkg.version,
    description: [
      'Backend for a digital bank, built on the NibssByPhoenix core-banking APIs.',
      '',
      '**Onboarding funnel** - each step is enforced by the API:',
      '1. `POST /auth/register` - create a customer profile',
      '2. `POST /kyc/bvn` *or* `POST /kyc/nin` - create and verify an identity record',
      '3. `POST /accounts` - open the single account, pre-funded with NGN 15,000',
      '4. `GET /accounts/name-enquiry/{accountNumber}` then `POST /transfers`',
      '',
      'All identity numbers are synthetic test values. Real BVNs and NINs are not accepted.',
      '',
      '**Data isolation** - every read is scoped to the authenticated customer. A',
      'transaction reference belonging to another customer returns 404.',
    ].join('\n'),
  },
  servers: [{ url: `http://localhost:${env.PORT}`, description: 'Local' }],
  tags: [
    { name: 'Health', description: 'Liveness and provider connectivity' },
    { name: 'Auth', description: 'Customer registration and sessions' },
    { name: 'KYC', description: 'BVN / NIN onboarding - required before an account can be opened' },
    { name: 'Accounts', description: 'Account creation, balance and name enquiry' },
    { name: 'Transfers', description: 'Intra-bank and inter-bank funds transfer' },
    { name: 'Transactions', description: 'History and status checks, scoped to the caller' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: { Account: accountSchema, Transaction: transactionSchema, Money: money, Error: errorResponse },
  },
  paths: {
    [p('/health')]: {
      get: { tags: ['Health'], summary: 'Service health', responses: { 200: okResp('Healthy', { type: 'object' }) } },
    },
    [p('/health/provider')]: {
      get: {
        tags: ['Health'],
        summary: 'Check NibssByPhoenix connectivity and credentials',
        responses: { 200: okResp('Checked', { type: 'object' }) },
      },
    },

    [p('/auth/register')]: {
      post: {
        tags: ['Auth'],
        summary: 'Register a customer',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'password'],
                properties: {
                  firstName: { type: 'string', example: 'John' },
                  lastName: { type: 'string', example: 'Doe' },
                  email: { type: 'string', format: 'email', example: 'john.doe@example.com' },
                  phone: { type: 'string', example: '08012345678' },
                  dateOfBirth: { type: 'string', format: 'date', example: '1995-06-15' },
                  password: { type: 'string', format: 'password', example: 'Passw0rd!' },
                },
              },
            },
          },
        },
        responses: {
          201: okResp('Registered', { type: 'object' }),
          409: err('Email or phone already registered'),
          422: err('Validation failed'),
        },
      },
    },
    [p('/auth/login')]: {
      post: {
        tags: ['Auth'],
        summary: 'Log in and receive a JWT',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', example: 'john.doe@example.com' },
                  password: { type: 'string', example: 'Passw0rd!' },
                },
              },
            },
          },
        },
        responses: { 200: okResp('Logged in', { type: 'object' }), 401: err('Invalid credentials') },
      },
    },
    [p('/auth/refresh')]: {
      post: {
        tags: ['Auth'],
        summary: 'Exchange a refresh token for a new access token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } },
            },
          },
        },
        responses: { 200: okResp('Refreshed', { type: 'object' }), 401: err('Refresh token invalid') },
      },
    },
    [p('/auth/me')]: {
      get: {
        tags: ['Auth'],
        summary: 'Current customer, account and next onboarding step',
        security: bearer,
        responses: { 200: okResp('Profile', { type: 'object' }), 401: err('Unauthenticated') },
      },
    },
    [p('/auth/change-password')]: {
      post: {
        tags: ['Auth'],
        summary: 'Change password and revoke existing sessions',
        security: bearer,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: okResp('Password changed', { type: 'object' }), 401: err('Current password incorrect') },
      },
    },

    [p('/kyc/status')]: {
      get: {
        tags: ['KYC'],
        summary: 'Current KYC status',
        security: bearer,
        responses: { 200: okResp('KYC status', { type: 'object' }) },
      },
    },
    [p('/kyc/bvn')]: {
      post: {
        tags: ['KYC'],
        summary: 'Create and verify a test BVN',
        description:
          'Creates a BVN record at NibssByPhoenix and immediately validates it. Omit `bvn` to have a synthetic 11-digit test value generated. Identity fields default to the registered profile.',
        security: bearer,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  bvn: { type: 'string', example: '12345678901' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  dateOfBirth: { type: 'string', format: 'date' },
                  phone: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: okResp('BVN created and verified', { type: 'object' }),
          409: err('KYC already completed'),
          422: err('Validation failed at the provider'),
        },
      },
    },
    [p('/kyc/nin')]: {
      post: {
        tags: ['KYC'],
        summary: 'Create and verify a test NIN',
        security: bearer,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nin: { type: 'string', example: '12345678901' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  dateOfBirth: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { 201: okResp('NIN created and verified', { type: 'object' }), 409: err('KYC already completed') },
      },
    },
    [p('/kyc/verify')]: {
      post: {
        tags: ['KYC'],
        summary: 'Link an existing BVN or NIN',
        security: bearer,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'identifier'],
                properties: {
                  type: { type: 'string', enum: ['BVN', 'NIN'] },
                  identifier: { type: 'string', example: '12345678901' },
                },
              },
            },
          },
        },
        responses: { 200: okResp('Verified', { type: 'object' }), 422: err('Could not be verified') },
      },
    },

    [p('/accounts')]: {
      post: {
        tags: ['Accounts'],
        summary: 'Open an account (requires verified KYC)',
        description:
          'Creates the account at NibssByPhoenix using the verified KYC record, pre-funds it with NGN 15,000 and writes an OPENING_CREDIT ledger entry. One account per customer.',
        security: bearer,
        responses: {
          201: okResp('Account created', { type: 'object', properties: { account: accountSchema, preFunded: money } }),
          403: err('KYC not verified'),
          409: err('Account limit reached'),
        },
      },
    },
    [p('/accounts/me')]: {
      get: {
        tags: ['Accounts'],
        summary: 'Your account',
        security: bearer,
        responses: { 200: okResp('Account', accountSchema), 404: err('No account yet') },
      },
    },
    [p('/accounts/balance')]: {
      get: {
        tags: ['Accounts'],
        summary: 'Account balance (live from the provider by default)',
        security: bearer,
        parameters: [
          {
            name: 'refresh',
            in: 'query',
            schema: { type: 'string', enum: ['true', 'false'], default: 'true' },
            description: 'Set false to read the local ledger without calling the provider.',
          },
        ],
        responses: { 200: okResp('Balance', accountSchema), 404: err('No account yet') },
      },
    },
    [p('/accounts/name-enquiry/{accountNumber}')]: {
      get: {
        tags: ['Accounts'],
        summary: 'Resolve a beneficiary before transferring',
        security: bearer,
        parameters: [{ name: 'accountNumber', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: okResp('Account resolved', {
            type: 'object',
            properties: {
              accountNumber: { type: 'string' },
              accountName: { type: 'string' },
              bankName: { type: 'string' },
              transferType: { type: 'string', enum: ['INTRA_BANK', 'INTER_BANK'] },
            },
          }),
          404: err('Account could not be resolved'),
        },
      },
    },

    [p('/transfers')]: {
      post: {
        tags: ['Transfers'],
        summary: 'Transfer funds (intra-bank or inter-bank)',
        description:
          'The source account is taken from the access token - it cannot be supplied. The destination is classified automatically: an account held in this bank is an intra-bank transfer, anything else routes out through NibssByPhoenix.',
        security: bearer,
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Optional. A repeat request with the same key returns the original transaction.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['destinationAccountNumber', 'amount'],
                properties: {
                  destinationAccountNumber: { type: 'string', example: '0123456789' },
                  amount: { type: 'number', example: 2500.5, description: 'Naira, max 2 decimal places' },
                  narration: { type: 'string', example: 'Rent contribution' },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: okResp('Transfer successful', {
            type: 'object',
            properties: { transaction: transactionSchema, balance: money },
          }),
          202: okResp('Accepted, outcome pending', { type: 'object' }),
          400: err('Self transfer, or amount outside limits'),
          402: err('Insufficient funds'),
          403: err('KYC required or account inactive'),
          422: err('Declined by the provider'),
        },
      },
    },

    [p('/transactions')]: {
      get: {
        tags: ['Transactions'],
        summary: 'Your transaction history',
        security: bearer,
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED'] },
          },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['DEBIT', 'CREDIT'] } },
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string', enum: ['OPENING_CREDIT', 'INTRA_BANK_TRANSFER', 'INTER_BANK_TRANSFER'] },
          },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'minAmount', in: 'query', schema: { type: 'number' } },
          { name: 'maxAmount', in: 'query', schema: { type: 'number' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: okResp('History', { type: 'array', items: transactionSchema }) },
      },
    },
    [p('/transactions/summary')]: {
      get: {
        tags: ['Transactions'],
        summary: 'Totals for your own activity',
        security: bearer,
        responses: { 200: okResp('Summary', { type: 'object' }) },
      },
    },
    [p('/transactions/{reference}')]: {
      get: {
        tags: ['Transactions'],
        summary: 'Transaction status check',
        description:
          'Returns the transaction only if it belongs to you. Non-terminal transactions are refreshed against NibssByPhoenix and the ledger is settled accordingly.',
        security: bearer,
        parameters: [
          { name: 'reference', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'refresh', in: 'query', schema: { type: 'string', enum: ['true', 'false'], default: 'true' } },
        ],
        responses: {
          200: okResp('Transaction', { type: 'object', properties: { transaction: transactionSchema } }),
          404: err('Not found on your account'),
        },
      },
    },
  },
};
