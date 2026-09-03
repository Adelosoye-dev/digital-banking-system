'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');

const env = require('./config/env');
const logger = require('./config/logger');
const requestId = require('./middleware/requestId');
const sanitize = require('./middleware/sanitize');
const { globalLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const routes = require('./routes');
const openapi = require('./docs/openapi');

function createApp() {
  const app = express();

  // Behind a load balancer (Render, Heroku, nginx) so req.ip is the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'RateLimit-Remaining', 'RateLimit-Reset'],
    })
  );
  app.use(compression());

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(sanitize);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === `${env.API_PREFIX}/health` },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
    })
  );

  app.use(env.API_PREFIX, globalLimiter);

  // Interactive docs for this bank API (not the provider one).
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapi, {
      customSiteTitle: `${env.BANK_NAME} API`,
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    })
  );
  app.get('/openapi.json', (_req, res) => res.json(openapi));

  app.get('/', (_req, res) =>
    res.json({
      success: true,
      message: `${env.BANK_NAME} core banking API`,
      version: require('../package.json').version,
      docs: '/docs',
      health: `${env.API_PREFIX}/health`,
    })
  );

  app.use(env.API_PREFIX, routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
module.exports.createApp = createApp;
