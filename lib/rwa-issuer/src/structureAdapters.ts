import type { ReviewedIssuerIdV1 } from './issuers.js';

export const REVIEWED_CAPABILITY_SOURCE_KINDS_V1 = [
  'reviewed_document',
  'reviewed_machine_api',
  'reviewed_source_code',
  'base_chain_call',
] as const;
export type ReviewedCapabilitySourceKindV1 = (typeof REVIEWED_CAPABILITY_SOURCE_KINDS_V1)[number];

export interface ReviewedCapabilitySourceV1 {
  kind: ReviewedCapabilitySourceKindV1;
  ref: string;
  reviewedAt: string;
}

export interface ReviewedTypedFieldV1<T extends string> {
  status: 'reviewed' | 'unknown';
  value: T | null;
  note: string;
  sources: readonly ReviewedCapabilitySourceV1[];
}

export interface RepresentationStructureAdapterV1 {
  issuerId: ReviewedIssuerIdV1;
  structure: ReviewedTypedFieldV1<'b20_beneficial_interest'>;
  claimModel: ReviewedTypedFieldV1<'direct_senior_beneficial_claim'>;
  transferRestrictions: ReviewedTypedFieldV1<'policy_screened_permissionless_secondary'>;
  redemption: ReviewedTypedFieldV1<'authorized_participant_primary_market'>;
  distributions: ReviewedTypedFieldV1<'reinvested_via_multiplier'>;
  corporateActions: ReviewedTypedFieldV1<'b20_multiplier_and_offchain_registry'>;
  bridge: ReviewedTypedFieldV1<never>;
  eligibility: ReviewedTypedFieldV1<'outside_us_secondary_permissionless_primary_kyc'>;
  referenceSource: ReviewedTypedFieldV1<'chainlink_total_return_feed'>;
  // -------------------------------------------------------------------------
  // The custody chain, named or absent.
  //
  // "A real share, held 1:1 by a regulated custodian" is the sentence the whole
  // product rests on, and until now this adapter recorded the CLAIM MODEL — a
  // direct senior beneficial claim — without ever naming who holds the share,
  // how it is held, or who supervises the holding. Those are three separate
  // facts, and a reader deciding whether a token is a real share is asking
  // about exactly those three.
  //
  // Recorded the same way as everything else here: from a document, dated,
  // quoted in the note, and `unknown` where the reviewed material does not
  // state it. `unknown` is the absence of a reviewed source, never a judgement
  // about the issuer.
  // -------------------------------------------------------------------------
  /** Who holds the underlying, and in what structure. */
  custody: ReviewedTypedFieldV1<'regulated_broker_custodian_bankruptcy_remote'>;
  /** Whose regulatory authority supervises that structure. */
  supervision: ReviewedTypedFieldV1<'adgm_regulatory_authority'>;
}

const REVIEWED_AT = '2026-09-01T00:00:00.000Z';
/** The Base post naming the custody chain was reviewed later than the rest. */
const REVIEWED_AT_CUSTODY = '2026-09-05T00:00:00.000Z';
const BASE_STOCKS = 'https://docs.base.org/base-chain/specs/reference/b20/tokenized-stocks-on-base';
const COINBASE_TOKENIZE = 'https://www.coinbase.com/tokenize';
/**
 * Base, "Stocks just got updated.", 24 August 2026.
 *
 * The post itself refuses every non-browser client, so the ref is the
 * publisher's blog rather than a deep link that could not be verified from
 * here; the title and the date identify the document, and the quote is carried
 * in the notes below.
 */
const BASE_STOCKS_POST = 'https://blog.base.org';

function source(
  kind: ReviewedCapabilitySourceKindV1,
  ref: string,
  reviewedAt: string = REVIEWED_AT,
): ReviewedCapabilitySourceV1 {
  return { kind, ref, reviewedAt };
}

function reviewed<T extends string>(
  value: T,
  note: string,
  sources: readonly ReviewedCapabilitySourceV1[],
): ReviewedTypedFieldV1<T> {
  return { status: 'reviewed', value, note, sources };
}

function unknown<T extends string>(note: string): ReviewedTypedFieldV1<T> {
  return { status: 'unknown', value: null, note, sources: [] };
}

export const REPRESENTATION_STRUCTURE_ADAPTERS_V1: Readonly<
  Record<ReviewedIssuerIdV1, RepresentationStructureAdapterV1>
> = {
  coinbase: {
    issuerId: 'coinbase',
    structure: reviewed(
      'b20_beneficial_interest',
      'A B20 representation of a beneficial interest held through the reviewed trust structure.',
      [source('reviewed_document', BASE_STOCKS), source('reviewed_document', COINBASE_TOKENIZE)],
    ),
    claimModel: reviewed(
      'direct_senior_beneficial_claim',
      'The reviewed issuer material describes a direct senior claim on the corresponding underlying interest; it is not inferred from the token symbol.',
      [source('reviewed_document', COINBASE_TOKENIZE)],
    ),
    transferRestrictions: reviewed(
      'policy_screened_permissionless_secondary',
      'Secondary holding and trading are documented as permissionless, while B20 policies can still block specific addresses and transfers.',
      [source('reviewed_document', BASE_STOCKS)],
    ),
    redemption: reviewed(
      'authorized_participant_primary_market',
      'Primary issuance and redemption are an authenticated/KYC authorized-participant process, not a consumer onchain exit route.',
      [source('reviewed_document', BASE_STOCKS), source('reviewed_document', COINBASE_TOKENIZE)],
    ),
    distributions: reviewed(
      'reinvested_via_multiplier',
      'Cash dividends are converted into underlying shares and reflected through the token multiplier, not paid as a separate cash exit.',
      [source('reviewed_document', BASE_STOCKS)],
    ),
    corporateActions: reviewed(
      'b20_multiplier_and_offchain_registry',
      'The B20 multiplier changes the redemption ratio. The standard documents scheduled multiplier updates and onchain announcements; current callable state still requires an exact-address read.',
      [source('reviewed_document', BASE_STOCKS)],
    ),
    bridge: unknown('No reviewed Coinbase representation-specific bridge route is established.'),
    eligibility: reviewed(
      'outside_us_secondary_permissionless_primary_kyc',
      'The product is limited to eligible jurisdictions outside the United States. Mint and redeem require an authorized participant; secondary holding/trading and address-policy checks are separate facts.',
      [source('reviewed_document', COINBASE_TOKENIZE), source('reviewed_document', BASE_STOCKS)],
    ),
    referenceSource: reviewed(
      'chainlink_total_return_feed',
      'Base Docs bind exact representations to Chainlink total-return feeds; freshness and market session remain separate evidence.',
      [source('reviewed_document', BASE_STOCKS)],
    ),
    custody: reviewed(
      'regulated_broker_custodian_bankruptcy_remote',
      'Authorized participants buy the shares and the shares are held by Alpaca, described as a regulated broker and custodian, in a structure described as bankruptcy-remote. This is a reviewed document, not an onchain read: nothing on Base can confirm the holding.',
      [source('reviewed_document', BASE_STOCKS_POST, REVIEWED_AT_CUSTODY)],
    ),
    supervision: reviewed(
      'adgm_regulatory_authority',
      'That structure is described as supervised by the regulatory authority of Abu Dhabi Global Market (ADGM). Supervision of the structure is not a statement about any holder’s own eligibility, which stays a separate field.',
      [source('reviewed_document', BASE_STOCKS_POST, REVIEWED_AT_CUSTODY)],
    ),
  },
};
