'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/docs/**'],
  testTimeout: 30000,
  verbose: true,
  clearMocks: true,
};
