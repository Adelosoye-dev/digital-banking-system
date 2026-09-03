'use strict';

const mongoose = require('mongoose');
const { TXN_TYPE, TXN_DIRECTION, TXN_STATUS, TERMINAL_TXN_STATUSES } = require('./constants');
const { money } = require('../utils/money');

const partySchema = new mongoose.Schema(
  {
    accountNumber: String,
    accountName: String,
    bankName: String,
    bankCode: String,
  },
  { _id: false }
);

const transactionSchema = new mongoose.Schema(
  {
    /** Client-facing reference. Unique per leg. */
    reference: { type: String, required: true, unique: true, index: true },
    /** Shared by the debit and credit legs of one intra-bank movement. */
    groupReference: { type: String, required: true, index: true },
    sessionId: { type: String, index: true },
    providerReference: { type: String, index: true, sparse: true },

    /** Owner of this leg. Every history query is scoped by this field. */
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },

    type: { type: String, enum: Object.values(TXN_TYPE), required: true },
    direction: { type: String, enum: Object.values(TXN_DIRECTION), required: true },
    status: { type: String, enum: Object.values(TXN_STATUS), default: TXN_STATUS.PENDING, index: true },

    /** Integer kobo. */
    amount: { type: Number, required: true, min: 0 },
    fee: { type: Number, default: 0, min: 0 },
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },
    currency: { type: String, default: 'NGN' },

    source: { type: partySchema, default: () => ({}) },
    destination: { type: partySchema, default: () => ({}) },

    narration: { type: String, maxlength: 140, default: '' },
    /** Caller-supplied idempotency key, unique per customer. */
    idempotencyKey: { type: String, index: true, sparse: true },

    failureReason: String,
    providerPayload: { type: mongoose.Schema.Types.Mixed, select: false },
    completedAt: Date,
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

// History is always "this customer, newest first".
transactionSchema.index({ customer: 1, createdAt: -1 });
transactionSchema.index({ account: 1, createdAt: -1 });
transactionSchema.index({ customer: 1, status: 1, createdAt: -1 });
// One idempotency key can only ever produce one transaction per customer.
transactionSchema.index(
  { customer: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

transactionSchema.virtual('isTerminal').get(function isTerminal() {
  return TERMINAL_TXN_STATUSES.includes(this.status);
});

transactionSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this.id,
    reference: this.reference,
    groupReference: this.groupReference,
    sessionId: this.sessionId,
    type: this.type,
    direction: this.direction,
    status: this.status,
    amount: money(this.amount),
    fee: money(this.fee),
    balanceBefore: this.balanceBefore === null ? null : money(this.balanceBefore),
    balanceAfter: this.balanceAfter === null ? null : money(this.balanceAfter),
    source: this.source,
    destination: this.destination,
    narration: this.narration,
    failureReason: this.failureReason,
    createdAt: this.createdAt,
    completedAt: this.completedAt,
  };
};

module.exports = mongoose.model('Transaction', transactionSchema);
