'use strict';

const env = require('./config/env');
const logger = require('./config/logger');
const db = require('./config/db');
const createApp = require('./app');

async function start() {
  await db.connect();
  await db.ensureIndexes();
  await db.supportsTransactions();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, prefix: env.API_PREFIX },
      `${env.BANK_NAME} API listening on http://localhost:${env.PORT}${env.API_PREFIX} (docs at /docs)`
    );
  });

  // Drain in-flight requests before exiting so no transfer is cut in half.
  const shutdown = (signal) => async () => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      try {
        await db.disconnect();
      } catch (err) {
        logger.error({ err }, 'Error closing the database connection');
      }
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after 10s grace period');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    logger.fatal({ err }, 'Failed to start the server');
    process.exit(1);
  });
}

module.exports = start;
