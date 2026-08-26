import { stableHashV1 } from '@mioagent/route-domain';
import type { B20BlockAnchorV1, B20ReaderV1, B20RpcReasonV1 } from '@mioagent/b20-control';

import {
  ReferenceExecutableComparisonV1Schema,
  ReferenceValueV1Schema,
  type ExecutableValueV1,
  type ReferenceExecutableComparisonV1,
  type ReferenceValueV1,
} from './contracts.js';

export const CHAINLINK_DECIMALS_SELECTOR_V1 = '0x313ce567' as const;
export const CHAINLINK_LATEST_ROUND_DATA_SELECTOR_V1 = '0xfeaf968c' as const;

/** The documented heartbeat is 24h during market hours. The extra two hours
 * tolerate scheduling drift; nights/weekends can therefore become `stale`
 * without being called broken. They are simply ineligible for divergence. */
export const TOKENIZED_STOCK_REFERENCE_MAX_AGE_SECONDS_V1 = 26 * 60 * 60;

function wordsV1(raw: string): string[] | null {
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  const body = raw.slice(2);
  if (body.length % 64 !== 0) return null;
  return body.match(/.{64}/g) ?? [];
}

function unsignedWordV1(word: string | undefined): bigint | null {
  if (!word || !/^[0-9a-fA-F]{64}$/.test(word)) return null;
  return BigInt(`0x${word}`);
}

function signedWordV1(word: string | undefined): bigint | null {
  const value = unsignedWordV1(word);
  if (value === null) return null;
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

export function unavailableTokenizedStockReferenceV1(input: {
  feedAddress: string | null;
  reason: 'reference_unavailable' | 'reference_invalid';
  status?: 'unavailable' | 'invalid';
}): ReferenceValueV1 {
  return ReferenceValueV1Schema.parse({
    status: input.status ?? 'unavailable',
    feedAddress: input.feedAddress,
    valueAtomic: null,
    decimals: null,
    feedUpdatedAt: null,
    ageSeconds: null,
    totalReturnValue: true,
    multiplierAppliedByFeed: true,
    registryPause: 'unknown',
    comparisonEligible: false,
    withheldReason: input.reason,
    evidence: null,
  });
}

/** Another issuer's reference model was not established. Null semantics are
 * intentional: Coinbase's total-return guarantees must not leak merely
 * because the common dossier contract has fields for them. */
export function unestablishedIssuerReferenceV1(): ReferenceValueV1 {
  return ReferenceValueV1Schema.parse({
    status: 'unavailable',
    feedAddress: null,
    valueAtomic: null,
    decimals: null,
    feedUpdatedAt: null,
    ageSeconds: null,
    totalReturnValue: null,
    multiplierAppliedByFeed: null,
    registryPause: 'unknown',
    comparisonEligible: false,
    withheldReason: 'reference_unavailable',
    evidence: null,
  });
}

export function referenceReadFailureReasonV1(reason: B20RpcReasonV1): string {
  return `chain_read_${reason}`;
}

export async function readTokenizedStockReferenceV1(
  reader: B20ReaderV1,
  input: {
    feedAddress: string | null;
    anchor: B20BlockAnchorV1;
    now: Date;
    /** Null until a reviewed registry ABI exists — reported as `unknown`, never
     * guessed. Unknown does not withhold the comparison; `true` does. */
    registryPause: boolean | null;
    maxAgeSeconds?: number;
  },
): Promise<ReferenceValueV1> {
  if (input.feedAddress === null) {
    return unavailableTokenizedStockReferenceV1({
      feedAddress: null,
      reason: 'reference_unavailable',
    });
  }
  const feedAddress = input.feedAddress.toLowerCase();
  const [decimalsRead, roundRead] = await (reader.callMany
    ? reader.callMany([
        { to: feedAddress, data: CHAINLINK_DECIMALS_SELECTOR_V1, blockTag: input.anchor.blockTag },
        {
          to: feedAddress,
          data: CHAINLINK_LATEST_ROUND_DATA_SELECTOR_V1,
          blockTag: input.anchor.blockTag,
        },
      ])
    : Promise.all([
        reader.call({
          to: feedAddress,
          data: CHAINLINK_DECIMALS_SELECTOR_V1,
          blockTag: input.anchor.blockTag,
        }),
        reader.call({
          to: feedAddress,
          data: CHAINLINK_LATEST_ROUND_DATA_SELECTOR_V1,
          blockTag: input.anchor.blockTag,
        }),
      ]));

  if (!decimalsRead?.ok || !roundRead?.ok) {
    return unavailableTokenizedStockReferenceV1({ feedAddress, reason: 'reference_unavailable' });
  }
  const decimalWords = wordsV1(decimalsRead.value);
  const roundWords = wordsV1(roundRead.value);
  const decimals = unsignedWordV1(decimalWords?.[0]);
  const roundId = unsignedWordV1(roundWords?.[0]);
  const answer = signedWordV1(roundWords?.[1]);
  const updatedAt = unsignedWordV1(roundWords?.[3]);
  const answeredInRound = unsignedWordV1(roundWords?.[4]);
  if (
    decimalWords?.length !== 1 ||
    roundWords?.length !== 5 ||
    decimals === null ||
    decimals > 36n ||
    roundId === null ||
    answer === null ||
    answer <= 0n ||
    updatedAt === null ||
    updatedAt <= 0n ||
    answeredInRound === null ||
    answeredInRound < roundId
  ) {
    return unavailableTokenizedStockReferenceV1({
      feedAddress,
      reason: 'reference_invalid',
      status: 'invalid',
    });
  }

  const updatedMs = Number(updatedAt) * 1_000;
  if (!Number.isSafeInteger(updatedMs) || updatedMs > input.now.getTime() + 5 * 60 * 1_000) {
    return unavailableTokenizedStockReferenceV1({
      feedAddress,
      reason: 'reference_invalid',
      status: 'invalid',
    });
  }
  const ageSeconds = Math.max(0, Math.floor((input.now.getTime() - updatedMs) / 1_000));
  const stale = ageSeconds > (input.maxAgeSeconds ?? TOKENIZED_STOCK_REFERENCE_MAX_AGE_SECONDS_V1);
  const registryPause =
    input.registryPause === null ? 'unknown' : input.registryPause ? 'paused' : 'not_paused';
  const status = registryPause === 'paused' ? 'paused' : stale ? 'stale' : 'fresh';
  // An unread pause flag is not a reason to withhold the comparison, and
  // requiring a positive `not_paused` withheld it on every card forever —
  // no code path can produce that value while the registry publishes no ABI.
  // Base's own documentation makes the pause observable through publication:
  // while the registry's pause flag is set, the feed stops publishing and holds
  // its last value. So a round published inside the feed's heartbeat is itself
  // the evidence that it was published unpaused, and the heartbeat is the thing
  // we actually read. A flag we CAN read and that says `paused` still withholds.
  const comparisonEligible = status === 'fresh';
  const withheldReason = comparisonEligible
    ? null
    : status === 'paused'
      ? 'reference_paused'
      : 'reference_stale';
  const observedAt = input.now.toISOString();
  const evidenceHash = stableHashV1('tokenized-stock-reference-read/v1', {
    chainId: 8453,
    feedAddress,
    blockNumber: input.anchor.blockNumber,
    blockHash: input.anchor.blockHash,
    decimalsResponse: decimalsRead.value.toLowerCase(),
    latestRoundDataResponse: roundRead.value.toLowerCase(),
  });

  return ReferenceValueV1Schema.parse({
    status,
    feedAddress,
    valueAtomic: answer.toString(),
    decimals: Number(decimals),
    feedUpdatedAt: new Date(updatedMs).toISOString(),
    ageSeconds,
    totalReturnValue: true,
    multiplierAppliedByFeed: true,
    registryPause,
    comparisonEligible,
    withheldReason,
    evidence: {
      kind: 'chainlink_feed',
      source: 'chainlink_v3_proxy_total_return',
      observedAt,
      blockNumber: input.anchor.blockNumber,
      blockHash: input.anchor.blockHash,
      targetAddress: feedAddress,
      method: 'decimals(); latestRoundData()',
      evidenceHash,
    },
  });
}

export function compareReferenceAndExecutableV1(
  reference: ReferenceValueV1,
  executable: ExecutableValueV1,
): ReferenceExecutableComparisonV1 {
  if (!reference.comparisonEligible || reference.status !== 'fresh') {
    const reason =
      reference.withheldReason ??
      (reference.status === 'stale'
        ? 'reference_stale'
        : reference.status === 'paused'
          ? 'reference_paused'
          : reference.status === 'invalid'
            ? 'reference_invalid'
            : 'reference_unavailable');
    return ReferenceExecutableComparisonV1Schema.parse({
      status: 'withheld',
      differenceBps: null,
      reason,
    });
  }
  if (!['full', 'partial'].includes(executable.status)) {
    const reason =
      executable.status === 'not_measured'
        ? 'executable_value_not_measured'
        : executable.status === 'buy_only'
          ? 'executable_value_buy_only'
          : executable.status === 'measurement_failed'
            ? 'executable_value_measurement_failed'
            : 'executable_value_unavailable';
    return ReferenceExecutableComparisonV1Schema.parse({
      status: 'withheld',
      differenceBps: null,
      reason,
    });
  }
  if (
    reference.valueAtomic === null ||
    reference.decimals === null ||
    executable.valueAtomic === null ||
    executable.decimals === null
  ) {
    return ReferenceExecutableComparisonV1Schema.parse({
      status: 'withheld',
      differenceBps: null,
      reason: 'executable_value_unavailable',
    });
  }
  const commonDecimals = Math.max(reference.decimals, executable.decimals);
  const referenceScaled =
    BigInt(reference.valueAtomic) * 10n ** BigInt(commonDecimals - reference.decimals);
  const executableScaled =
    BigInt(executable.valueAtomic) * 10n ** BigInt(commonDecimals - executable.decimals);
  if (referenceScaled <= 0n) {
    return ReferenceExecutableComparisonV1Schema.parse({
      status: 'withheld',
      differenceBps: null,
      reason: 'reference_invalid',
    });
  }
  return ReferenceExecutableComparisonV1Schema.parse({
    status: 'comparable',
    differenceBps: (((executableScaled - referenceScaled) * 10_000n) / referenceScaled).toString(),
    reason: null,
  });
}
