import { z } from 'zod';
import {
  isOfficialV1,
  type IssuerRepresentationRepositoryV1,
  type OfficialAssetIdentityV1,
  type OfficialAssetRepositoryV1,
  type OfficialLookalikeRepositoryV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// "Is this the real one?" — the question a person asks with an address in one
// hand and a symbol in the other, answered from stored evidence and nothing
// else.
//
// Everything Miorail needs to answer it has been on file for weeks: 44 source
// listings over the reviewed official corpus, the issuer registries, and 160
// stored resemblances pointing at 12 official assets (measured 2026-09-16).
// All of it sat behind a session. The people most likely to ask are the people
// least likely to have one — somebody looking at a token in a wallet, or an
// assistant asked the question on their behalf.
//
// WHAT MAKES THIS SAFE TO PUBLISH, given that every reading it returns is an
// accusation or an endorsement:
//
//   * It answers ONLY from stored rows. No chain read, no provider, no fan-out
//     a caller could aim. An address nobody has written anything about costs
//     two indexed lookups and returns "nothing on file".
//
//   * `unknown_to_miorail` is about OUR CORPUS. It is not "safe", not "not
//     official", and not a verdict of any kind. This is the failure mode this
//     product was built to avoid, so the word "unknown" travels in the
//     standing, in the sentence and in the caveats.
//
//   * A lookalike is a RESEMBLANCE and says so: two strings matched and two
//     addresses did not. No score, no severity, no "scam" — the stored rows
//     carry none and this surface invents none.
//
//   * An address a reviewed root vouches for can never be reported as an
//     impostor, and it is checked HERE as well as in the store. Dinari's Base
//     dShare declares `symbol() = "AAPL"` exactly; it is legitimate, and no
//     reviewed source says which security it stands for. Both halves have to
//     be sayable at once, which is why `issuer_representation` is its own
//     standing rather than a softened "official".
// ---------------------------------------------------------------------------

const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;

export const ADDRESS_IDENTITY_STANDINGS_V1 = [
  /** A reviewed source still lists this exact address. */
  'reviewed_official',
  /** A reviewed source listed it once and no longer does. An event, not a
   * demotion to impostor: the address is the same contract it always was. */
  'delisted_official',
  /** An issuer's own root vouches for the address, and no reviewed source
   * publishes which security it represents. */
  'issuer_representation',
  /** A stored resemblance to an official asset's name. */
  'known_lookalike',
  /** Nothing on file. About Miorail, never about the token. */
  'unknown_to_miorail',
] as const;
export type AddressIdentityStandingV1 = (typeof ADDRESS_IDENTITY_STANDINGS_V1)[number];

export const AddressIdentityCheckInputV1Schema = z
  .object({
    chainId: z
      .literal(8453)
      .describe('Base mainnet. The only chain this corpus covers.'),
    tokenAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .describe('The EXACT contract address to check. Never a ticker or a name.'),
  })
  .strict();
export type AddressIdentityCheckInputV1 = z.infer<typeof AddressIdentityCheckInputV1Schema>;

export const AddressIdentityCheckOutputV1Schema = z
  .object({
    schemaVersion: z.literal('address-identity/v1'),
    chainId: z.literal(8453),
    tokenAddress: z.string().regex(ADDRESS_V1),
    standing: z.enum(ADDRESS_IDENTITY_STANDINGS_V1),
    /** Miorail's own deterministic reading, written by no model. The sentence
     * to repeat rather than paraphrase. */
    answer: z.string().min(1).max(600),
    official: z
      .object({
        ticker: z.string().min(1).max(16),
        displayName: z.string().max(120).nullable(),
        issuer: z.string().min(1).max(80),
        /** Which reviewed sources name it, and whether each still does. */
        listedIn: z
          .array(
            z
              .object({
                sourceKind: z.string().min(1).max(60),
                currentlyListed: z.boolean(),
                lastSeenAt: z.string().datetime(),
              })
              .strict(),
          )
          .max(8),
      })
      .strict()
      .nullable(),
    issuerRepresentation: z
      .object({
        issuerId: z.string().min(1).max(40),
        rootKey: z.string().min(1).max(120),
        observedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    lookalike: z
      .object({
        /** The address it resembles. Compare THIS with what you were given. */
        officialAddress: z.string().regex(ADDRESS_V1),
        officialTicker: z.string().min(1).max(16).nullable(),
        matchKind: z.string().min(1).max(40),
        matchedAlias: z.string().min(1).max(40),
        /** The normalized string both sides shared, so a reader sees WHY. */
        matchedValue: z.string().min(1).max(120),
        /** What the contract itself declared when it was flagged. Copied at
         * flag time: this metadata is mutable on chain. */
        declaredSymbol: z.string().max(120),
        declaredName: z.string().max(200),
        firstFlaggedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    /** What this answer was drawn from, so a reader can size the silence. */
    corpus: z
      .object({
        lookalikeRows: z.number().int().min(0),
        lookalikesLastScannedAt: z.string().datetime().nullable(),
      })
      .strict(),
    caveats: z.array(z.string().min(1).max(400)).min(1).max(8),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type AddressIdentityCheckOutputV1 = z.infer<typeof AddressIdentityCheckOutputV1Schema>;

/** The sentences that must travel with every reading, whatever it says. */
const STANDING_CAVEATS_V1: readonly string[] = [
  'This answers from stored evidence only. Nothing here was read from the chain for this request, and no absence in it was measured now.',
  'Compare ADDRESSES, not symbols. A symbol is what an impostor supplies; the address is the identity.',
];

const UNKNOWN_CAVEAT_V1 =
  '`unknown_to_miorail` is a statement about Miorail’s corpus and never a verdict on the token. It does not mean safe, and it does not mean not official — it means nothing has been written down here.';

const LOOKALIKE_CAVEAT_V1 =
  'A lookalike row is a RESEMBLANCE: two strings matched and two addresses did not. It carries no score and no severity, it is not an accusation of fraud, and a contract can wear a name for ordinary reasons.';

const OFFICIAL_CAVEAT_V1 =
  'Official means a reviewed source still lists this exact address. It says nothing about price, liquidity, whether a wallet may hold it, or whether anybody can sell it.';

function tickerOfV1(identity: OfficialAssetIdentityV1 | null): string | null {
  if (!identity) return null;
  const listed = identity.listings.find((row) => row.currentlyListed) ?? identity.listings[0];
  return listed?.ticker ?? null;
}

function officialViewV1(identity: OfficialAssetIdentityV1) {
  const newest = [...identity.listings].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  return {
    ticker: newest?.ticker ?? '',
    displayName: newest?.displayName ?? null,
    issuer: identity.issuer,
    listedIn: identity.listings.slice(0, 8).map((row) => ({
      sourceKind: row.sourceKind,
      currentlyListed: row.currentlyListed,
      lastSeenAt: row.lastSeenAt,
    })),
  };
}

export interface AddressIdentityCheckDepsV1 {
  official: OfficialAssetRepositoryV1;
  lookalikes: OfficialLookalikeRepositoryV1;
  /** Optional: without it, an issuer's own representation reads as unknown
   * rather than being mislabelled. A missing registry is a smaller error than
   * an invented standing. */
  issuers?: IssuerRepresentationRepositoryV1 | null;
  now: () => Date;
}

/**
 * One address, one standing, one sentence.
 *
 * The order of the branches is the whole safety argument. Identity outranks
 * resemblance: an official contract and an issuer's own contract are decided
 * before any stored string match is consulted, so the strongest possible match
 * can never outrank the address itself. The store enforces the same rule on
 * the write side; it is repeated here because the two sets are assembled by
 * different code paths and a disagreement between them must resolve to the
 * safe answer rather than to whichever ran last.
 */
export async function assembleAddressIdentityCheckV1(
  deps: AddressIdentityCheckDepsV1,
  input: AddressIdentityCheckInputV1,
): Promise<AddressIdentityCheckOutputV1> {
  const tokenAddress = input.tokenAddress.toLowerCase();
  if (!ADDRESS_V1.test(tokenAddress)) {
    throw new Error('identity check: an exact Base address is required');
  }
  const generatedAt = deps.now().toISOString();

  const [identity, counts] = await Promise.all([
    deps.official.officialIdentity({ chainId: input.chainId, tokenAddress }),
    deps.lookalikes.lookalikeCounts({ chainId: input.chainId }),
  ]);
  const corpus = {
    lookalikeRows: counts.total,
    lookalikesLastScannedAt: counts.lastSeenAt,
  };

  if (identity && identity.listings.length > 0) {
    const official = officialViewV1(identity);
    const listed = isOfficialV1(identity);
    return AddressIdentityCheckOutputV1Schema.parse({
      schemaVersion: 'address-identity/v1',
      chainId: input.chainId,
      tokenAddress,
      standing: listed ? 'reviewed_official' : 'delisted_official',
      answer: listed
        ? `Yes. ${tokenAddress} is ${official.ticker}, issued by ${official.issuer}, and ${official.listedIn.filter((row) => row.currentlyListed).length} reviewed source(s) still list this exact address.`
        : `${tokenAddress} is ${official.ticker} from ${official.issuer}, and no reviewed source lists it any more. It is the same contract it always was; what changed is the source, and that is an event rather than a verdict on the token.`,
      official,
      issuerRepresentation: null,
      lookalike: null,
      corpus,
      caveats: [OFFICIAL_CAVEAT_V1, ...STANDING_CAVEATS_V1],
      generatedAt,
    });
  }

  const membership = deps.issuers
    ? await deps.issuers.membershipFor({ chainId: input.chainId, tokenAddresses: [tokenAddress] })
    : [];
  // `established`, never merely present: a row whose newest read REFUTED
  // membership is the root saying no, and reading any row as a vouching would
  // turn a refusal into an endorsement.
  const vouched =
    membership.find(
      (row) => row.tokenAddress === tokenAddress && row.membership === 'established',
    ) ?? null;
  if (vouched) {
    return AddressIdentityCheckOutputV1Schema.parse({
      schemaVersion: 'address-identity/v1',
      chainId: input.chainId,
      tokenAddress,
      standing: 'issuer_representation',
      answer: `${tokenAddress} is vouched for by ${vouched.issuerId}’s own registry, so it is not an impostor. No reviewed source publishes which security it stands for, so Miorail will not say which company it represents — those are two different questions and only the first is answered here.`,
      official: null,
      issuerRepresentation: {
        issuerId: vouched.issuerId,
        rootKey: vouched.rootKey,
        observedAt: vouched.lastCheckedAt,
      },
      lookalike: null,
      corpus,
      caveats: [
        'An issuer vouching for an address establishes who deployed it, not what it represents. Membership is not identity.',
        ...STANDING_CAVEATS_V1,
      ],
      generatedAt,
    });
  }

  const lookalike = await deps.lookalikes.lookalikeFor({
    chainId: input.chainId,
    tokenAddress,
  });
  if (lookalike) {
    const impersonated = await deps.official.officialIdentity({
      chainId: input.chainId,
      tokenAddress: lookalike.officialAddress,
    });
    const officialTicker = tickerOfV1(impersonated);
    return AddressIdentityCheckOutputV1Schema.parse({
      schemaVersion: 'address-identity/v1',
      chainId: input.chainId,
      tokenAddress,
      standing: 'known_lookalike',
      answer: `No. ${tokenAddress} is not ${officialTicker ?? lookalike.officialAddress}. It declared ${lookalike.launchSymbol ? `"${lookalike.launchSymbol}"` : 'a name'} and that string matches ${officialTicker ?? 'an official asset'}, whose contract is ${lookalike.officialAddress}. Two strings matched and two addresses did not — which is a resemblance, not a finding of fraud.`,
      official: null,
      issuerRepresentation: null,
      lookalike: {
        officialAddress: lookalike.officialAddress,
        officialTicker,
        matchKind: lookalike.matchKind,
        matchedAlias: lookalike.matchedAlias,
        matchedValue: lookalike.matchedValue,
        declaredSymbol: lookalike.launchSymbol,
        declaredName: lookalike.launchName,
        firstFlaggedAt: lookalike.firstFlaggedAt,
      },
      corpus,
      caveats: [LOOKALIKE_CAVEAT_V1, ...STANDING_CAVEATS_V1],
      generatedAt,
    });
  }

  return AddressIdentityCheckOutputV1Schema.parse({
    schemaVersion: 'address-identity/v1',
    chainId: input.chainId,
    tokenAddress,
    standing: 'unknown_to_miorail',
    answer: `Miorail has nothing on file for ${tokenAddress}. It is not in the reviewed official corpus, no reviewed issuer root vouches for it, and it is not among the ${corpus.lookalikeRows} contracts recorded as wearing an official asset’s name. That is a statement about this corpus and not about the token.`,
    official: null,
    issuerRepresentation: null,
    lookalike: null,
    corpus,
    caveats: [UNKNOWN_CAVEAT_V1, ...STANDING_CAVEATS_V1],
    generatedAt,
  });
}
