import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { z } from 'zod';

import {
  DossierControlsV1Schema,
  MarketTopologyV1Schema,
  RecentMarketActivityV1Schema,
  ReferenceValueV1Schema,
} from './contracts.js';
import { OfficialCashExitRungPreviewV1Schema, OFFICIAL_ROUTE_STATUSES_V1 } from './discover.js';

// ---------------------------------------------------------------------------
// Phase 7 — one pasted address, read as deeply as the evidence allows.
//
// The official dossier answers "tell me everything about this contract" and
// refuses anything outside the reviewed corpus, which is correct for what it
// is and useless as a research surface: almost every address a person pastes
// is not one of thirteen Coinbase equities.
//
// This contract is the same read with the identity question opened up. Four
// trust roots are stated SEPARATELY and never merged, because merging them is
// how a resemblance becomes a claim:
//
//   OFFICIAL          a reviewed source lists this exact address
//   PROJECT VERIFIED  a domain the project controls claims this exact address
//   INDEXED LAUNCH    the B20 index ingested it; that is provenance, not trust
//   LOOKALIKE         it declares a name an official asset also answers to
//
// A pasted string is an ADDRESS. Nothing here resolves a symbol, because the
// symbol is exactly what an impostor supplies -- 61.7% of indexed launches
// share one with another launch, and two different CHEESEBURGE contracts once
// sat on one screen with contradicting numbers.
//
// The last two fields are the acceptance criterion turned into data:
// `established` and `unknown` say, in the reader's words, what this read did
// and did not settle. They are computed from the bundle above them and can say
// nothing the bundle does not contain.
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
const Hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const Timestamp = z.string().datetime();
const Digits = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedDigits = z.string().regex(/^-?(0|[1-9][0-9]*)$/);

/**
 * The strongest root that applies, for ordering a surface — never a score.
 *
 * `indexed_launch` is deliberately BELOW project_verified and deliberately not
 * a trust statement at all: being in the index means the pinned factory emitted
 * it, which says who deployed the contract standard and nothing about who is
 * behind the token.
 */
export const ADDRESS_STANDINGS_V1 = [
  'official',
  'project_verified',
  'indexed_launch',
  'unknown_to_miorail',
] as const;
export type AddressStandingV1 = (typeof ADDRESS_STANDINGS_V1)[number];

export const AddressIdentityV1Schema = z
  .object({
    standing: z.enum(ADDRESS_STANDINGS_V1),
    official: z
      .object({
        ticker: z.string().min(1).max(16),
        displayName: z.string().min(1).max(120).nullable(),
        issuer: z.string().min(1).max(80),
        listedIn: z.array(z.enum(['base_docs_technical', 'base_product_list'])).max(4),
        sourceDiscrepancy: z.boolean(),
        referenceFeedAddress: Address.nullable(),
      })
      .strict()
      .nullable(),
    project: z
      .object({
        claimantDomain: z.string().min(1).max(253),
        status: z.string().min(1).max(40),
        verifiedAt: Timestamp.nullable(),
      })
      .strict()
      .nullable(),
    launch: z
      .object({
        /** What the deployer typed. Display metadata, never identity. */
        symbol: z.string().max(120),
        name: z.string().max(200),
        decimals: z.number().int().min(0).max(255).nullable(),
        canonical: z.boolean(),
        blockNumber: Digits.nullable(),
        detectedAt: Timestamp.nullable(),
      })
      .strict()
      .nullable(),
    lookalike: z
      .object({
        officialAddress: Address,
        officialTicker: z.string().min(1).max(16),
        matchKind: z.enum(['symbol_exact', 'symbol_normalized', 'name_normalized']),
        matchedAlias: z.enum(['published_ticker', 'underlying', 'display_name']),
        matchedValue: z.string().min(1).max(120),
        firstFlaggedAt: Timestamp,
      })
      .strict()
      .nullable(),
    /**
     * WHO put this contract on chain, when that is establishable at all.
     *
     * The address is present only when the launch transaction went STRAIGHT to
     * the B20 factory. Measured across the whole stored corpus, 458 launches
     * were sent to the ERC-4337 EntryPoint by eight senders — bundlers relaying
     * UserOperations for unrelated people — and 3,440 went through one
     * intermediary contract. On any of those, `tx.from` is whoever paid to
     * include the transaction, and presenting it as a deployer would file one
     * project's record under another's infrastructure.
     *
     * So `relation` decides what may be shown, and every non-direct relation
     * shows the relation and no address at all.
     */
    origin: z
      .object({
        status: z.enum(['established', 'relayed', 'transaction_absent', 'not_read', 'no_launch_row']),
        /** Present ONLY for `established` — a direct-to-factory sender. */
        deployerAddress: Address.nullable(),
        relation: z
          .enum(['direct', 'bundler', 'intermediary', 'contract_creation'])
          .nullable(),
        readAt: Timestamp.nullable(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.status !== 'established' && value.deployerAddress !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['deployerAddress'],
            message: 'only a direct-to-factory sender may be shown as an address',
          });
        }
        if (value.status === 'established' && value.relation !== 'direct') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relation'],
            message: 'an established origin is a direct-to-factory launch',
          });
        }
      }),
    /** What the chain itself answered. `unavailable` is our read failing. */
    contract: z
      .object({
        status: z.enum(['read', 'unavailable']),
        isB20: z.boolean().nullable(),
        symbol: z.string().max(120).nullable(),
        name: z.string().max(200).nullable(),
        decimals: z.number().int().min(0).max(255).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // An official contract is never an impostor. Enforced here as well as in
    // the store, because this is the object a screen renders.
    if (value.official !== null && value.lookalike !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lookalike'],
        message: 'an officially listed address cannot also be a lookalike of one',
      });
    }
    if (value.standing === 'official' && value.official === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['standing'],
        message: 'official standing requires a reviewed listing',
      });
    }
  });
export type AddressIdentityV1 = z.infer<typeof AddressIdentityV1Schema>;

/**
 * What moved since the previous comparable reading.
 *
 * Comparable means the same size to the same destination in two runs that both
 * completed. `first_reading` is not a change of nothing -- it is the absence of
 * anything to compare with, and the two must not share a sentence.
 */
export const CashExitChangeV1Schema = z
  .object({
    status: z.enum(['compared', 'first_reading', 'not_comparable']),
    previousMeasuredAt: Timestamp.nullable(),
    measuredAt: Timestamp.nullable(),
    rungs: z
      .array(
        z
          .object({
            requestedCashAtomic: Digits,
            destination: z.enum(['USDC', 'ETH']),
            previousRoundTripCostBps: SignedDigits.nullable(),
            roundTripCostBps: SignedDigits.nullable(),
            /** Signed, stored rather than derived: a surface subtracting two
             * numbers can do it in the wrong order, and this one cannot. */
            changeBps: SignedDigits.nullable(),
            previousStatus: z.string().min(1).max(40),
            status: z.string().min(1).max(40),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type CashExitChangeV1 = z.infer<typeof CashExitChangeV1Schema>;

export const AddressMarketV1Schema = z
  .object({
    routeStatus: z.enum(OFFICIAL_ROUTE_STATUSES_V1),
    measuredAt: Timestamp.nullable(),
    approvedSources: z.array(z.string().min(1).max(100)).max(16),
    ladder: z.array(OfficialCashExitRungPreviewV1Schema).max(16),
    change: CashExitChangeV1Schema,
    topology: MarketTopologyV1Schema,
    activity: RecentMarketActivityV1Schema,
  })
  .strict();

/** One thing this read settled, and the evidence that settles it. */
export const EstablishedFactV1Schema = z
  .object({
    claim: z.string().min(1).max(240),
    evidence: z.string().min(1).max(240),
  })
  .strict();

/** One thing it did not, and why. Never "no" — always "not established". */
export const UnknownFactV1Schema = z
  .object({
    claim: z.string().min(1).max(240),
    reason: z.string().min(1).max(240),
  })
  .strict();

export const AddressDossierV1Schema = z
  .object({
    schemaVersion: z.literal('address-dossier/v1'),
    dossierHash: Hash,
    assembly: z.literal('deterministic_no_llm_facts'),
    chainId: z.literal(8453),
    tokenAddress: Address,
    assembledAt: Timestamp,
    identity: AddressIdentityV1Schema,
    /** Only when a reviewed source binds a feed to this exact address. Null is
     * not "no price" — it is "nothing reviewed publishes one". */
    referenceValue: ReferenceValueV1Schema.nullable(),
    controls: DossierControlsV1Schema,
    market: AddressMarketV1Schema,
    established: z.array(EstablishedFactV1Schema).max(24),
    unknown: z.array(UnknownFactV1Schema).max(24),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dossierHash !== hashAddressDossierV1(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dossierHash'],
        message: 'dossier hash mismatch',
      });
    }
  });
export type AddressDossierV1 = z.infer<typeof AddressDossierV1Schema>;

export function hashAddressDossierV1(value: Record<string, unknown>): HashV1 {
  const { dossierHash: _dossierHash, ...content } = value;
  return stableHashV1('address-dossier/v1', content);
}
