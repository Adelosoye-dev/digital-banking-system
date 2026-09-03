'use strict';

const pino = require('pino');
const env = require('./env');

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.apiSecret',
  'req.body.apiKey',
  'res.headers["set-cookie"]',
  'apiKey',
  'apiSecret',
  'password',
  'token',
  'accessToken',
];

/**
 * Pretty logs locally, structured JSON in production.
 *
 * pino-pretty is a devDependency, so a host that prunes dev deps (Render does)
 * would crash at boot if we asked for it there. Probe for it instead of
 * assuming NODE_ENV alone tells us whether it is installed.
 */
function prettyTransport() {
  if (env.isProduction) return undefined;
  try {
    require.resolve('pino-pretty');
  } catch (_err) {
    return undefined;
  }
  return {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service,env' },
  };
}

const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'digital-banking-system', env: env.NODE_ENV },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: prettyTransport(),
});

module.exports = logger;
