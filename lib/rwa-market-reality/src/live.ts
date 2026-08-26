import { stableHashV1 } from '@mioagent/route-domain';
import type { CashExitMeasurementRunV1 } from '@mioagent/route-storage';

import { assembleMarketRealityV1, type MarketRealityDepsV1 } from './engine.js';
import {
  MarketRealityQuestionV1Schema,
  type MarketRealityDirectionV1,
  type MarketRealityQuestionV1,
  type MarketRealityResponseV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Live Market Reality: measure the exact question, now, once.
//
// THE MISMATCH THIS EXISTS TO CLOSE
//
// A router quote is valid for about twenty seconds. The background sampler runs
// on a timer measured in tens of minutes. Those two numbers are three orders of
// magnitude apart, so a reader has never once opened this product and seen an
// open quote — every representation of every security reported "not measured",
// for tokens that had been measured perfectly forty minutes earlier.
//
// No amount of sampling fixes that. Sampling every twenty seconds would be a
// permanent router load for a page nobody has open. The answer is to measure
// when somebody asks, and to keep the background samples as what they actually
// are: history.
//
// WHAT "DEDUPLICATED" MEANS HERE, EXACTLY
//
// Three separate savings, and they are not the same one written three ways:
//
//   1. Single-flight. Ten readers opening NVIDIA at $1k in the same second
//      share ONE measurement. The key is the exact question, so a reader asking
//      about $10k is not served a $1k answer.
//   2. Open evidence is not re-measured. A representation whose quote is still
//      inside its own validity window is already current; asking the router
//      again would spend a call to learn what we hold.
//   3. A cooldown per representation. Without it a page that refreshes on a
//      timer becomes the sampler we just decided not to build.
//
// Only representations that need measuring are measured. A security with three
// representations where two are already open costs one router call, not three.
//
// WHAT THIS PATH IS NOT
//
// It is not execution, and it never becomes execution. It writes quote evidence
// to Miorail's own tables and nothing else: no signer, no wallet call, no
// allowance, no transaction. `quoteEvidenceIsExecutionProof` stays false on the
// way out for the same reason it is false on the read path.
// ---------------------------------------------------------------------------

/** How long a representation is left alone after it was measured, whatever the
 * answer. Set to the quote validity: below it a second measurement produces
 * evidence that expires at the same moment as the evidence we already hold. */
export const MARKET_REALITY_COOLDOWN_MS_V1 = 20_000;

/**
 * The exact question, as one key.
 *
 * Every field that changes the answer is in it, and nothing that does not.
 * Direction, size and destination are obvious; `approvedSources` is here
 * because two measurements through different router sets are not comparable and
 * must not be deduplicated onto each other — which is the same rule the
 * coverage gate enforces on the read side.
 */
export function marketRealityQuestionHashV1(input: {
  question: MarketRealityQuestionV1;
  approvedSources: readonly string[];
}): string {
  return stableHashV1('market-reality-question/v1', {
    chainId: input.question.chainId,
    underlyingKey: input.question.underlyingKey,
    direction: input.question.direction,
    requestedCashAtomic: input.question.requestedCashAtomic,
    destination: input.question.destination,
    approvedSources: [...input.approvedSources].sort(),
  });
}

/** One representation, as the measurement path needs it. Resolved by the
 * caller, because reading `decimals()` belongs to whoever holds a chain
 * reader — not to a projection package. */
export interface MarketRealityMeasurableV1 {
  tokenAddress: string;
  symbol: string;
  decimals: number;
}

export type MarketRealityResolveOutcomeV1 =
  | { ok: true; token: MarketRealityMeasurableV1 }
  /** The chain would not tell us what this token is, so it cannot be measured.
   * Ours, and it must not be recorded as anything about the token. */
  | { ok: false; reason: string };

export interface MarketRealityLiveDepsV1 extends MarketRealityDepsV1 {
  /** What the router set is. Named, sorted, and part of the question key. */
  approvedSources: readonly string[];
  /** Read a representation's symbol and decimals. */
  resolveToken: (tokenAddress: string) => Promise<MarketRealityResolveOutcomeV1>;
  /** Measure ONE representation at ONE exact size and destination. */
  measureOne: (input: {
    token: MarketRealityMeasurableV1;
    requestedCashAtomic: string;
    destination: 'USDC' | 'ETH';
  }) => Promise<CashExitMeasurementRunV1>;
}

export interface MarketRealityLiveResultV1 {
  answer: MarketRealityResponseV1;
  /** What this call actually spent. A surface may say "nothing was measured
   * because everything was already current" instead of implying it refreshed. */
  measured: string[];
  /** Representations left alone because their evidence was still open. */
  reusedOpen: string[];
  /** Representations left alone because they were measured moments ago. */
  reusedCooldown: string[];
  /** Representations we could not measure, and why. Never a claim about them. */
  unresolved: { tokenAddress: string; reason: string }[];
  /** True when this caller joined an in-flight measurement instead of starting
   * one. Reported so a caller cannot mistake sharing for staleness. */
  joinedInFlight: boolean;
}

/**
 * The coordinator. Holds the in-flight map and the cooldown clock.
 *
 * Process-local on purpose. A shared lock across replicas would be a
 * distributed-systems problem bought to save at most a handful of router calls,
 * and the cost of getting it wrong — a lock nobody releases — is a surface that
 * never measures anything again.
 */
export function createMarketRealityCoordinatorV1(options?: {
  cooldownMs?: number;
  now?: () => Date;
}) {
  const cooldownMs = options?.cooldownMs ?? MARKET_REALITY_COOLDOWN_MS_V1;
  const clock = options?.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<MarketRealityLiveResultV1>>();
  /** questionHash + representation -> when it was last measured. */
  const lastMeasuredAt = new Map<string, number>();

  async function run(
    deps: MarketRealityLiveDepsV1,
    question: MarketRealityQuestionV1,
    questionHash: string,
  ): Promise<MarketRealityLiveResultV1> {
    const before = await assembleMarketRealityV1(deps, {
      underlyingKey: question.underlyingKey,
      direction: question.direction,
      requestedCashAtomic: question.requestedCashAtomic,
      destination: question.destination,
    });

    const measured: string[] = [];
    const reusedOpen: string[] = [];
    const reusedCooldown: string[] = [];
    const unresolved: { tokenAddress: string; reason: string }[] = [];

    for (const representation of before.representations) {
      const address = representation.tokenAddress;
      // Already current. Asking the router again would spend a call to learn
      // what we are already holding.
      if (representation.liveness === 'live') {
        reusedOpen.push(address);
        continue;
      }
      const cooldownKey = `${questionHash}:${address}`;
      const previous = lastMeasuredAt.get(cooldownKey);
      if (previous !== undefined && clock().getTime() - previous < cooldownMs) {
        reusedCooldown.push(address);
        continue;
      }
      const resolved = await deps.resolveToken(address);
      if (!resolved.ok) {
        unresolved.push({ tokenAddress: address, reason: resolved.reason });
        continue;
      }
      await deps.measureOne({
        token: resolved.token,
        requestedCashAtomic: question.requestedCashAtomic,
        destination: question.destination,
      });
      lastMeasuredAt.set(cooldownKey, clock().getTime());
      measured.push(address);
    }

    // Re-assembled from storage rather than patched in memory: the read path is
    // the only thing allowed to decide what counts as current, and a live
    // answer that took a shortcut around it would be a second definition of
    // freshness that could disagree with the first.
    const answer =
      measured.length === 0
        ? before
        : await assembleMarketRealityV1(deps, {
            underlyingKey: question.underlyingKey,
            direction: question.direction,
            requestedCashAtomic: question.requestedCashAtomic,
            destination: question.destination,
          });

    return {
      answer,
      measured: measured.sort(),
      reusedOpen: reusedOpen.sort(),
      reusedCooldown: reusedCooldown.sort(),
      unresolved,
      joinedInFlight: false,
    };
  }

  return {
    /** How many questions are being measured right now. For a health read. */
    inFlightCount: () => inFlight.size,

    async measure(
      deps: MarketRealityLiveDepsV1,
      input: {
        underlyingKey: string;
        direction: MarketRealityDirectionV1;
        requestedCashAtomic: string;
        destination?: 'USDC' | 'ETH';
      },
    ): Promise<MarketRealityLiveResultV1> {
      const question = MarketRealityQuestionV1Schema.parse({
        chainId: 8453,
        underlyingKey: input.underlyingKey,
        direction: input.direction,
        requestedCashAtomic: input.requestedCashAtomic,
        cashAsset: 'USDC',
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        cashDecimals: 6,
        destination: input.destination ?? 'USDC',
        exactSizeOnly: true,
        baseOnly: true,
      });
      const questionHash = marketRealityQuestionHashV1({
        question,
        approvedSources: deps.approvedSources,
      });

      const existing = inFlight.get(questionHash);
      if (existing) {
        // Sharing, not staleness. The joiner gets the same measurement and is
        // told it did not start one, so a surface can say so honestly.
        const shared = await existing;
        return { ...shared, joinedInFlight: true };
      }

      const started = run(deps, question, questionHash).finally(() => {
        inFlight.delete(questionHash);
      });
      inFlight.set(questionHash, started);
      return started;
    },
  };
}

export type MarketRealityCoordinatorV1 = ReturnType<typeof createMarketRealityCoordinatorV1>;
