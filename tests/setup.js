'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-zod';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-long-enough-too';
// Keep bcrypt cheap so the suite is not dominated by hashing.
process.env.BCRYPT_SALT_ROUNDS = '8';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { serverSelectionTimeoutMS: 20_000 });
}, 120_000);

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));

  // The name-enquiry cache is process-wide; a stale entry would leak between tests.
  require('../src/modules/accounts/accounts.service').clearNameCache();
  require('./fakeProvider').reset();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
