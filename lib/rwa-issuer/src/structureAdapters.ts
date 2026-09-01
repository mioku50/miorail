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
  structure: ReviewedTypedFieldV1<
    'b20_beneficial_interest' | 'dshare_rebasing_erc20' | 'tracker_certificate'
  >;
  claimModel: ReviewedTypedFieldV1<
    'direct_senior_beneficial_claim' | 'issuer_securities_entitlement' | 'bearer_debt_tracker'
  >;
  transferRestrictions: ReviewedTypedFieldV1<
    | 'policy_screened_permissionless_secondary'
    | 'blacklist_restrictor'
    | 'no_technical_restrictions'
  >;
  redemption: ReviewedTypedFieldV1<
    | 'authorized_participant_primary_market'
    | 'issuer_account_kyc'
    | 'existing_holders_supported_new_issuance_closed'
  >;
  distributions: ReviewedTypedFieldV1<
    'reinvested_via_multiplier' | 'registered_account_cash_distribution'
  >;
  corporateActions: ReviewedTypedFieldV1<
    | 'b20_multiplier_and_offchain_registry'
    | 'balance_per_share_and_offchain_cash'
    | 'rebasing_multiplier'
  >;
  bridge: ReviewedTypedFieldV1<'layerzero_v2_oft'>;
  eligibility: ReviewedTypedFieldV1<
    | 'outside_us_secondary_permissionless_primary_kyc'
    | 'issuer_account_and_jurisdiction'
    | 'restricted_jurisdictions_primary_kyc'
  >;
  referenceSource: ReviewedTypedFieldV1<
    'chainlink_total_return_feed' | 'issuer_authenticated_market_data'
  >;
}

const REVIEWED_AT = '2026-09-01T00:00:00.000Z';
const BASE_STOCKS = 'https://docs.base.org/base-chain/specs/reference/b20/tokenized-stocks-on-base';
const COINBASE_TOKENIZE = 'https://www.coinbase.com/tokenize';
const DINARI_DOCS = 'https://docs.dinari.com';
const BACKED_LEGAL = 'https://assets.backed.fi/legal-documentation';
const BACKED_PRODUCTS = 'https://assets.backed.fi/products';
const BACKED_API = 'https://docs.xstocks.fi/_bundle/apis/@v1/openapi.json?download=';
const BACKED_CONTRACT = 'https://github.com/backed-fi/backed-token-contract';

function source(kind: ReviewedCapabilitySourceKindV1, ref: string): ReviewedCapabilitySourceV1 {
  return { kind, ref, reviewedAt: REVIEWED_AT };
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
  },
  dinari: {
    issuerId: 'dinari',
    structure: reviewed(
      'dshare_rebasing_erc20',
      'A rebasing dShare ERC-20; its optional ERC-4626 wrapper is a separate representation.',
      [source('reviewed_document', DINARI_DOCS), source('base_chain_call', 'balancePerShare()')],
    ),
    claimModel: reviewed(
      'issuer_securities_entitlement',
      'The entitlement model is established by issuer documentation, not by mutable token metadata.',
      [source('reviewed_document', DINARI_DOCS)],
    ),
    transferRestrictions: reviewed(
      'blacklist_restrictor',
      'The exact dShare names an onchain transfer restrictor; this is not a residency oracle.',
      [source('reviewed_document', DINARI_DOCS), source('base_chain_call', 'transferRestrictor()')],
    ),
    redemption: reviewed(
      'issuer_account_kyc',
      'Redemption is an offchain issuer-account process and is never compared with a router quote.',
      [source('reviewed_document', DINARI_DOCS)],
    ),
    distributions: reviewed(
      'registered_account_cash_distribution',
      'Cash distributions depend on an issuer-registered account; a secondary-market holder is not assumed eligible.',
      [source('reviewed_document', DINARI_DOCS)],
    ),
    corporateActions: reviewed(
      'balance_per_share_and_offchain_cash',
      'Splits affect balance-per-share while cash distributions remain an account-level process.',
      [source('reviewed_document', DINARI_DOCS), source('base_chain_call', 'balancePerShare()')],
    ),
    bridge: reviewed(
      'layerzero_v2_oft',
      'The deployed token exposes the LayerZero V2 OFT surface; supported peers remain unknown until exact destinations answer.',
      [source('reviewed_document', DINARI_DOCS), source('base_chain_call', 'endpoint()')],
    ),
    eligibility: reviewed(
      'issuer_account_and_jurisdiction',
      'Mint/redeem eligibility is held by the issuer account and jurisdiction process and is not inferable onchain.',
      [source('reviewed_document', DINARI_DOCS)],
    ),
    referenceSource: reviewed(
      'issuer_authenticated_market_data',
      'Issuer market data is authenticated and unavailable without organization credentials; another issuer feed is not a substitute.',
      [source('reviewed_machine_api', DINARI_DOCS)],
    ),
  },
  backed: {
    issuerId: 'backed',
    structure: reviewed(
      'tracker_certificate',
      'Base bTokens are Swiss-law tracker certificates represented as ERC-20 tokens.',
      [source('reviewed_document', BACKED_LEGAL), source('reviewed_machine_api', BACKED_API)],
    ),
    claimModel: reviewed(
      'bearer_debt_tracker',
      'The legal product is a bearer debt tracker certificate, not direct ownership or voting rights in the underlying.',
      [source('reviewed_document', BACKED_LEGAL)],
    ),
    transferRestrictions: reviewed(
      'no_technical_restrictions',
      'Current issuer legal documentation describes bTokens/ERC-20 tokens without technical transfer restrictions.',
      [source('reviewed_document', BACKED_LEGAL)],
    ),
    redemption: reviewed(
      'existing_holders_supported_new_issuance_closed',
      'The issuer product list says new bToken issuance is closed while redemption remains supported for existing holders.',
      [source('reviewed_document', BACKED_PRODUCTS)],
    ),
    distributions: reviewed(
      'reinvested_via_multiplier',
      'The published legacy EVM implementation represents rebase effects through its multiplier and adjusted balanceOf.',
      [source('reviewed_source_code', BACKED_CONTRACT)],
    ),
    corporateActions: reviewed(
      'rebasing_multiplier',
      'The published legacy EVM implementation schedules multiplier updates and applies them in balanceOf.',
      [source('reviewed_source_code', BACKED_CONTRACT)],
    ),
    bridge: unknown(
      'Current xStocks bridge documentation is not treated as evidence for legacy Base bTokens.',
    ),
    eligibility: reviewed(
      'restricted_jurisdictions_primary_kyc',
      'Jurisdiction restrictions are documented and issuer redemption remains an eligibility-dependent process.',
      [source('reviewed_document', BACKED_LEGAL), source('reviewed_document', BACKED_PRODUCTS)],
    ),
    referenceSource: unknown(
      'The reviewed bTokens identity API does not by itself establish a fresh executable or reference price.',
    ),
  },
};
