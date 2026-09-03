'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

mongoose.set('strictQuery', true);
// Fail fast instead of buffering queries forever when Mongo is unreachable.
mongoose.set('bufferCommands', false);

let replicaSetAvailable = null;

async function connect(uri = env.activeMongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    minPoolSize: 2,
    autoIndex: !env.isProduction,
  });

  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');

  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  return mongoose.connection;
}

/**
 * Builds every schema-declared index once, explicitly.
 *
 * autoIndex is disabled in production so Mongoose does not attempt an index
 * build on every single boot, but a fresh Atlas database starts with none -
 * and the uniqueness this system relies on (one email, one account number, one
 * transaction reference, one idempotency key per customer) lives entirely in
 * those indexes. Without this call a production deploy against an empty
 * cluster would silently accept duplicates.
 */
async function ensureIndexes() {
  const models = require('../models');
  const targets = [models.Customer, models.Account, models.Transaction];
  for (const model of targets) {
    try {
      await model.createIndexes();
    } catch (err) {
      // A conflicting legacy index should be visible, not fatal at boot.
      logger.error({ err, model: model.modelName }, 'Failed to build indexes');
    }
  }
  logger.info({ models: targets.map((m) => m.modelName) }, 'Indexes ensured');
}

/**
 * Multi-document transactions require a replica set / mongos. A plain
 * standalone `mongod` (the common local dev setup) does not support them,
 * so we detect support once and let callers degrade gracefully.
 */
async function supportsTransactions() {
  if (replicaSetAvailable !== null) return replicaSetAvailable;
  try {
    const info = await mongoose.connection.db.admin().command({ hello: 1 });
    replicaSetAvailable = Boolean(info.setName || info.msg === 'isdbgrid');
  } catch (err) {
    logger.warn({ err }, 'Could not determine replica-set support; assuming none');
    replicaSetAvailable = false;
  }
  if (!replicaSetAvailable) {
    logger.warn('MongoDB is standalone - ledger writes fall back to compensating updates instead of transactions');
  }
  return replicaSetAvailable;
}

async function disconnect() {
  replicaSetAvailable = null;
  await mongoose.connection.close();
}

module.exports = { connect, disconnect, supportsTransactions, ensureIndexes, mongoose };
