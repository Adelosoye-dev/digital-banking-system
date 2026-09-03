'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const { ACCOUNT_STATUS } = require('./constants');
const { money } = require('../utils/money');

const accountSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    accountNumber: { type: String, required: true, unique: true, index: true, trim: true },
    accountName: { type: String, required: true, trim: true },
    bankName: { type: String, default: () => env.BANK_NAME },
    bankCode: { type: String, default: () => env.BANK_CODE },
    currency: { type: String, default: 'NGN' },
    /** Ledger balance in integer kobo. The provider remains the source of truth; this is our mirror. */
    balance: { type: Number, required: true, default: 0, min: 0 },
    /** Funds held against in-flight debits. Available = balance - lockedBalance. */
    lockedBalance: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.ACTIVE, index: true },
    kycType: String,
    providerAccountId: String,
    providerPayload: { type: mongoose.Schema.Types.Mixed, select: false },
    lastSyncedAt: Date,
    openedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.__v;
        delete ret.providerPayload;
        return ret;
      },
    },
  }
);

accountSchema.virtual('availableBalance').get(function availableBalance() {
  return Math.max(0, this.balance - this.lockedBalance);
});

accountSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this.id,
    accountNumber: this.accountNumber,
    accountName: this.accountName,
    bankName: this.bankName,
    bankCode: this.bankCode,
    status: this.status,
    currency: this.currency,
    balance: money(this.balance),
    availableBalance: money(this.availableBalance),
    lockedBalance: money(this.lockedBalance),
    openedAt: this.openedAt,
    lastSyncedAt: this.lastSyncedAt,
  };
};

/** Counterparty view - what any other customer is allowed to learn about this account. */
accountSchema.methods.toCounterpartyJSON = function toCounterpartyJSON() {
  return {
    accountNumber: this.accountNumber,
    accountName: this.accountName,
    bankName: this.bankName,
    bankCode: this.bankCode,
    status: this.status,
  };
};

module.exports = mongoose.model('Account', accountSchema);
