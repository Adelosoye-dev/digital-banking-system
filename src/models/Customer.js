'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { KYC_TYPE, KYC_STATUS, CUSTOMER_STATUS, ROLE } = require('./constants');

const kycSchema = new mongoose.Schema(
  {
    type: { type: String, enum: Object.values(KYC_TYPE) },
    // Stored so account creation can replay it to the provider. Never returned in full.
    identifier: { type: String, trim: true },
    status: { type: String, enum: Object.values(KYC_STATUS), default: KYC_STATUS.PENDING },
    verifiedAt: Date,
    firstName: String,
    lastName: String,
    dateOfBirth: String, // ISO yyyy-mm-dd, exactly as the provider expects it
    phone: String,
    providerResponse: { type: mongoose.Schema.Types.Mixed, select: false },
    failureReason: String,
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, required: true, trim: true },
    dateOfBirth: { type: String, required: true }, // ISO yyyy-mm-dd
    password: { type: String, required: true, select: false, minlength: 8 },
    role: { type: String, enum: Object.values(ROLE), default: ROLE.CUSTOMER },
    status: {
      type: String,
      enum: Object.values(CUSTOMER_STATUS),
      default: CUSTOMER_STATUS.PENDING_KYC,
      index: true,
    },
    kyc: { type: kycSchema, default: () => ({}) },
    lastLoginAt: Date,
    // Bumped on password change so previously-issued JWTs stop working.
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        delete ret.tokenVersion;
        if (ret.kyc) {
          delete ret.kyc.providerResponse;
          if (ret.kyc.identifier) ret.kyc.identifier = maskIdentifier(ret.kyc.identifier);
        }
        return ret;
      },
    },
  }
);

function maskIdentifier(value) {
  if (!value || value.length < 5) return '***';
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 5)}${value.slice(-2)}`;
}

customerSchema.virtual('fullName').get(function fullName() {
  return `${this.firstName} ${this.lastName}`.trim();
});

customerSchema.virtual('isKycVerified').get(function isKycVerified() {
  return this.kyc?.status === KYC_STATUS.VERIFIED;
});

customerSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, env.BCRYPT_SALT_ROUNDS);
  return next();
});

customerSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Customer', customerSchema);
module.exports.maskIdentifier = maskIdentifier;
