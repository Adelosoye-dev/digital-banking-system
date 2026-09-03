'use strict';

const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const { syntheticKycId } = require('../../utils/reference');
const nibss = require('../../integrations/nibss/nibss.service');
const { Customer } = require('../../models');
const { KYC_TYPE, KYC_STATUS, CUSTOMER_STATUS } = require('../../models/constants');
const { maskIdentifier } = require('../../models/Customer');

/**
 * KYC is the first gate in the onboarding funnel:
 *
 *   register -> CREATE BVN or NIN (here) -> validate -> create account
 *
 * An account can only be opened once kyc.status === VERIFIED, which is
 * enforced by requireKyc middleware and re-checked inside the account service.
 */

function kycView(customer) {
  const kyc = customer.kyc || {};
  return {
    status: kyc.status || KYC_STATUS.PENDING,
    type: kyc.type || null,
    identifier: kyc.identifier ? maskIdentifier(kyc.identifier) : null,
    firstName: kyc.firstName || null,
    lastName: kyc.lastName || null,
    dateOfBirth: kyc.dateOfBirth || null,
    verifiedAt: kyc.verifiedAt || null,
    failureReason: kyc.failureReason || null,
    canCreateAccount: kyc.status === KYC_STATUS.VERIFIED,
  };
}

function assertNotAlreadyVerified(customer) {
  if (customer.kyc && customer.kyc.status === KYC_STATUS.VERIFIED) {
    throw ApiError.conflict(
      `Your ${customer.kyc.type} has already been verified. Each customer completes KYC once.`,
      { code: 'KYC_ALREADY_VERIFIED', details: kycView(customer) }
    );
  }
}

/** No two customers may claim the same identity document. */
async function assertIdentifierUnclaimed(identifier, customerId) {
  const claimed = await Customer.findOne({
    'kyc.identifier': identifier,
    _id: { $ne: customerId },
  })
    .select('_id')
    .lean();

  if (claimed) {
    throw ApiError.conflict('That identity document is already linked to another customer', {
      code: 'KYC_IDENTIFIER_TAKEN',
    });
  }
}

/** Identity details default to what the customer registered with, keeping records consistent. */
function identityFrom(customer, overrides = {}) {
  return {
    firstName: overrides.firstName || customer.firstName,
    lastName: overrides.lastName || customer.lastName,
    dateOfBirth: overrides.dateOfBirth || customer.dateOfBirth,
    phone: overrides.phone || customer.phone,
  };
}

async function persistVerified(customer, { type, identifier, identity, providerResponse }) {
  customer.kyc = {
    type,
    identifier,
    status: KYC_STATUS.VERIFIED,
    verifiedAt: new Date(),
    firstName: identity.firstName,
    lastName: identity.lastName,
    dateOfBirth: identity.dateOfBirth,
    phone: identity.phone,
    providerResponse,
    failureReason: undefined,
  };
  if (customer.status === CUSTOMER_STATUS.PENDING_KYC) customer.status = CUSTOMER_STATUS.KYC_VERIFIED;
  await customer.save();
  logger.info({ customerId: customer.id, kycType: type }, 'KYC verified');
  return customer;
}

async function persistFailure(customer, { type, identifier, reason }) {
  customer.kyc = {
    ...(customer.kyc ? customer.kyc.toObject() : {}),
    type,
    identifier,
    status: KYC_STATUS.FAILED,
    failureReason: reason,
    verifiedAt: undefined,
  };
  await customer.save({ validateBeforeSave: false });
}

const kycService = {
  getStatus(customer) {
    return kycView(customer);
  },

  /**
   * Creates a BVN at NibssByPhoenix, then immediately validates it.
   * Creation alone is not enough - the record only counts once validation passes.
   */
  async createBvn(customer, input = {}) {
    assertNotAlreadyVerified(customer);

    const identity = identityFrom(customer, input);
    const bvn = input.bvn || syntheticKycId();
    await assertIdentifierUnclaimed(bvn, customer._id);

    logger.info({ customerId: customer.id, bvn: maskIdentifier(bvn) }, 'Creating BVN at NibssByPhoenix');

    const insert = await nibss.insertBvn({
      bvn,
      firstName: identity.firstName,
      lastName: identity.lastName,
      dob: identity.dateOfBirth,
      phone: identity.phone,
    });

    const validation = await nibss.validateBvn(insert.bvn);
    if (!validation.valid) {
      await persistFailure(customer, {
        type: KYC_TYPE.BVN,
        identifier: insert.bvn,
        reason: 'Provider could not validate the newly created BVN',
      });
      throw ApiError.unprocessable('BVN was created but failed validation. Please try again.', {
        code: 'KYC_VALIDATION_FAILED',
      });
    }

    await persistVerified(customer, {
      type: KYC_TYPE.BVN,
      identifier: insert.bvn,
      identity,
      providerResponse: { insert: insert.raw, validate: validation.raw },
    });

    return {
      kyc: kycView(customer),
      // Returned once, at creation, so the customer can keep their test BVN.
      bvn: insert.bvn,
      nextStep: 'CREATE_ACCOUNT',
    };
  },

  async createNin(customer, input = {}) {
    assertNotAlreadyVerified(customer);

    const identity = identityFrom(customer, input);
    const nin = input.nin || syntheticKycId();
    await assertIdentifierUnclaimed(nin, customer._id);

    logger.info({ customerId: customer.id, nin: maskIdentifier(nin) }, 'Creating NIN at NibssByPhoenix');

    const insert = await nibss.insertNin({
      nin,
      firstName: identity.firstName,
      lastName: identity.lastName,
      dob: identity.dateOfBirth,
    });

    const validation = await nibss.validateNin(insert.nin);
    if (!validation.valid) {
      await persistFailure(customer, {
        type: KYC_TYPE.NIN,
        identifier: insert.nin,
        reason: 'Provider could not validate the newly created NIN',
      });
      throw ApiError.unprocessable('NIN was created but failed validation. Please try again.', {
        code: 'KYC_VALIDATION_FAILED',
      });
    }

    await persistVerified(customer, {
      type: KYC_TYPE.NIN,
      identifier: insert.nin,
      identity,
      providerResponse: { insert: insert.raw, validate: validation.raw },
    });

    return { kyc: kycView(customer), nin: insert.nin, nextStep: 'CREATE_ACCOUNT' };
  },

  /** Links an identifier that already exists at the provider to this customer. */
  async verifyExisting(customer, { type, identifier }) {
    assertNotAlreadyVerified(customer);
    await assertIdentifierUnclaimed(identifier, customer._id);

    const validation = type === KYC_TYPE.BVN ? await nibss.validateBvn(identifier) : await nibss.validateNin(identifier);

    if (!validation.valid) {
      await persistFailure(customer, { type, identifier, reason: `${type} not found or invalid at provider` });
      throw ApiError.unprocessable(`${type} could not be verified`, { code: 'KYC_VALIDATION_FAILED' });
    }

    const identity = identityFrom(customer, {
      firstName: validation.firstName,
      lastName: validation.lastName,
      dateOfBirth: validation.dateOfBirth,
      phone: validation.phone,
    });

    await persistVerified(customer, { type, identifier, identity, providerResponse: validation.raw });
    return { kyc: kycView(customer), nextStep: 'CREATE_ACCOUNT' };
  },
};

module.exports = kycService;
module.exports.kycView = kycView;
