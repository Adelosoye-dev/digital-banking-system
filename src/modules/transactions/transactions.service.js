'use strict';

const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const { money, koboToNaira } = require('../../utils/money');
const { transactionReference } = require('../../utils/reference');
const nibss = require('../../integrations/nibss/nibss.service');
const { Account, Transaction } = require('../../models');
const {
  TXN_STATUS,
  TXN_DIRECTION,
  TXN_TYPE,
  TERMINAL_TXN_STATUSES,
} = require('../../models/constants');
const { __ledger } = require('../transfers/transfers.service');

const { commitDebit, releaseReservation, creditAccount } = __ledger;

/**
 * Transaction history and status.
 *
 * DATA ISOLATION: every query in this file starts from
 * `{ customer: customer._id }`. There is no code path that reads a
 * transaction by reference alone - the owner filter is part of the same
 * query, so a valid reference belonging to somebody else returns 404, not 403,
 * and leaks nothing about whether it exists.
 */

async function buildFilter(customer, query) {
  const filter = { customer: customer._id };

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;
  if (query.direction) filter.direction = query.direction;

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) filter.createdAt.$lte = new Date(`${query.to}T23:59:59.999Z`);
  }

  if (query.minAmount !== undefined || query.maxAmount !== undefined) {
    filter.amount = {};
    if (query.minAmount !== undefined) filter.amount.$gte = Math.round(query.minAmount * 100);
    if (query.maxAmount !== undefined) filter.amount.$lte = Math.round(query.maxAmount * 100);
  }

  if (query.search) {
    // Escape the input so a user cannot inject regex metacharacters.
    const safe = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [
      { reference: rx },
      { narration: rx },
      { 'source.accountName': rx },
      { 'destination.accountName': rx },
      { 'destination.accountNumber': rx },
    ];
  }

  return filter;
}

const transactionsService = {
  /** Paginated history for the authenticated customer only. */
  async history(customer, query) {
    const { page, limit } = query;
    const filter = await buildFilter(customer, query);

    const [items, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Transaction.countDocuments(filter),
    ]);

    return { items: items.map((t) => t.toPublicJSON()), total, page, limit };
  },

  /**
   * Status check for one transaction.
   *
   * Non-terminal transactions are refreshed against NibssByPhoenix and the
   * ledger is settled accordingly, so polling this endpoint is what finally
   * resolves a transfer whose outcome was indeterminate.
   */
  async getByReference(customer, reference, { refresh = true } = {}) {
    const txn = await Transaction.findOne({ customer: customer._id, reference });

    if (!txn) {
      throw ApiError.notFound('No transaction with that reference exists on your account', {
        code: 'TRANSACTION_NOT_FOUND',
      });
    }

    if (!refresh || TERMINAL_TXN_STATUSES.includes(txn.status)) {
      return { transaction: txn.toPublicJSON(), refreshed: false };
    }

    try {
      const remote = await nibss.getTransaction(txn.providerReference || txn.reference);
      const settled = await settle(txn, remote);
      return { transaction: settled.toPublicJSON(), refreshed: true, providerStatus: remote.status };
    } catch (err) {
      logger.warn(
        { reference, err: err.message },
        'Could not refresh transaction status from provider - returning last known state'
      );
      return {
        transaction: txn.toPublicJSON(),
        refreshed: false,
        note: 'Live status is temporarily unavailable; showing the last known state.',
      };
    }
  },

  /** Aggregate view of the caller own activity. */
  async summary(customer) {
    const rows = await Transaction.aggregate([
      { $match: { customer: customer._id, status: TXN_STATUS.SUCCESS } },
      { $group: { _id: '$direction', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const byDirection = rows.reduce((acc, r) => ({ ...acc, [r._id]: r }), {});
    const credited = byDirection[TXN_DIRECTION.CREDIT] || { total: 0, count: 0 };
    const debited = byDirection[TXN_DIRECTION.DEBIT] || { total: 0, count: 0 };

    const [pending, account] = await Promise.all([
      Transaction.countDocuments({
        customer: customer._id,
        status: { $in: [TXN_STATUS.PENDING, TXN_STATUS.PROCESSING] },
      }),
      Account.findOne({ customer: customer._id }),
    ]);

    return {
      totalCredited: money(credited.total),
      totalDebited: money(debited.total),
      netFlow: money(credited.total - debited.total),
      creditCount: credited.count,
      debitCount: debited.count,
      pendingCount: pending,
      currentBalance: account ? money(account.balance) : null,
    };
  },
};

/**
 * Applies a provider verdict to a pending/processing transaction and settles
 * the ledger. Reservations made at transfer time are consumed here.
 */
async function settle(txn, remote) {
  if (remote.status === TXN_STATUS.SUCCESS) {
    const committed = await commitDebit(txn.account, txn.amount);

    txn.status = TXN_STATUS.SUCCESS;
    txn.balanceAfter = committed ? committed.balance : txn.balanceAfter;
    txn.completedAt = new Date();
    txn.failureReason = undefined;
    txn.providerReference = remote.reference || txn.providerReference;
    await txn.save();

    // Mirror the credit leg for an intra-bank transfer that settled late.
    if (txn.type === TXN_TYPE.INTRA_BANK_TRANSFER && txn.direction === TXN_DIRECTION.DEBIT) {
      const alreadyCredited = await Transaction.exists({
        groupReference: txn.groupReference,
        direction: TXN_DIRECTION.CREDIT,
      });

      if (!alreadyCredited) {
        const beneficiary = await Account.findOne({ accountNumber: txn.destination.accountNumber });
        if (beneficiary) {
          const credited = await creditAccount(beneficiary._id, txn.amount);
          await Transaction.create({
            reference: transactionReference('TRX'),
            groupReference: txn.groupReference,
            sessionId: txn.sessionId,
            customer: beneficiary.customer,
            account: beneficiary._id,
            type: txn.type,
            direction: TXN_DIRECTION.CREDIT,
            status: TXN_STATUS.SUCCESS,
            amount: txn.amount,
            balanceBefore: credited.balance - txn.amount,
            balanceAfter: credited.balance,
            source: txn.source,
            destination: txn.destination,
            narration: txn.narration,
            providerReference: txn.providerReference,
            completedAt: new Date(),
          });
        }
      }
    }

    logger.info({ reference: txn.reference, amount: koboToNaira(txn.amount) }, 'Pending transfer settled as SUCCESS');
    return txn;
  }

  if (remote.status === TXN_STATUS.FAILED || remote.status === TXN_STATUS.REVERSED) {
    // Give the held funds back.
    const released = await releaseReservation(txn.account, txn.amount);

    txn.status = remote.status === TXN_STATUS.REVERSED ? TXN_STATUS.REVERSED : TXN_STATUS.FAILED;
    txn.balanceAfter = released ? released.balance : txn.balanceBefore;
    txn.completedAt = new Date();
    txn.failureReason = remote.message || 'Transfer was not completed by NibssByPhoenix';
    await txn.save();

    logger.info({ reference: txn.reference, status: txn.status }, 'Pending transfer settled as unsuccessful');
    return txn;
  }

  // Still pending upstream - leave the reservation in place.
  return txn;
}

module.exports = transactionsService;
module.exports.settle = settle;
