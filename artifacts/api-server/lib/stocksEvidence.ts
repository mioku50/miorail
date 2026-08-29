import type {
  MarketRealityHistoryV1,
  MarketRealityRepresentationV2,
  MarketRealityResponseV2,
} from '@mioagent/rwa-market-reality/contracts';
import type {
  StocksEvidenceItemV1,
  StocksEvidenceKindV1,
} from '@mioagent/rwa-market-reality/narration-contract';

import type { B20AnswerAssertionsV1 } from './b20AnswerVerify.js';

// ---------------------------------------------------------------------------
// The Stocks evidence bundle: typed Market Reality evidence, flattened into
// citable items, with a deterministic answer already written from them.
//
// This is the same shape the B20 narrator already runs on — plan, bundle,
// narrate, verify, fall back — with one addition the older surface did not
// need: every item carries an ID and the representation it belongs to.
//
// The ID is not decoration. A Stocks answer is about several representations
// of ONE security at once, and the failure that shape invites is a sentence
// about Backed built from Coinbase's reference evidence. Reading well, wrong,
// and unfalsifiable without knowing which row each clause came from. So a
// claim cites the items it stands on, and the verifier checks the citation
// against the subject rather than against the whole bundle.
//
// Nothing here calls a provider, reads a chain or takes a wallet. The bundle
// is a pure function of an already-assembled market-reality/v2 answer.
// ---------------------------------------------------------------------------

// The evidence row is part of the wire contract now — Phase 13.2 renders the
// provenance — so its shape lives beside the answer it supports rather than
// here. What stays here is how a row is BUILT.
export {
  STOCKS_EVIDENCE_KINDS_V1,
  type StocksEvidenceItemV1,
  type StocksEvidenceKindV1,
} from '@mioagent/rwa-market-reality/narration-contract';

export interface StocksSubjectV1 {
  tokenAddress: string;
  issuerId: 'coinbase' | 'dinari' | 'backed';
  representationKind: 'b20_asset' | 'rebasing_erc20' | 'non_rebasing_erc4626_wrapper';
}

export interface StocksEvidenceBundleV1 {
  question: string;
  underlyingKey: string;
  subjects: readonly StocksSubjectV1[];
  items: readonly StocksEvidenceItemV1[];
  /** Named absences. The ONLY things a narration may state as not established. */
  missing: readonly string[];
  /** Sentences that must survive any paraphrase. */
  caveats: readonly string[];
  /** Router names this bundle mentions. A narration naming any other venue is
   * describing a market nobody measured. */
  approvedSources: readonly string[];
  /** True while at least one representation carries evidence inside its own
   * validity window. False makes every present-tense price claim a lie. */
  hasOpenEvidence: boolean;
  /** The answer that ships when the narration is refused. */
  deterministic: string;
  assertions: B20AnswerAssertionsV1;
}

const USDC_DECIMALS_V1 = 6;

/** Atomic to a decimal string, exact — no float ever touches a cash figure. */
export function scaledDecimalV1(atomic: string, decimals: number): string {
  const negative = atomic.startsWith('-');
  const digits = (negative ? atomic.slice(1) : atomic).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function ageMinutesV1(observedAt: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(observedAt)) / 60_000));
}

function shortKindV1(kind: StocksSubjectV1['representationKind']): string {
  return kind === 'b20_asset'
    ? 'B20 asset'
    : kind === 'rebasing_erc20'
      ? 'rebasing ERC-20'
      : 'non-rebasing ERC-4626 wrapper';
}

interface BuilderStateV1 {
  items: StocksEvidenceItemV1[];
  next: number;
}

function push(
  state: BuilderStateV1,
  kind: StocksEvidenceKindV1,
  subject: string | null,
  label: string,
  value: string,
): StocksEvidenceItemV1 {
  const item: StocksEvidenceItemV1 = { id: `e${state.next}`, kind, subject, label, value };
  state.next += 1;
  state.items.push(item);
  return item;
}

function supplyItemsV1(
  state: BuilderStateV1,
  row: MarketRealityRepresentationV2,
): { missing: string[]; sentence: string } {
  const address = row.tokenAddress;
  const missing: string[] = [];
  if (row.supply.state === 'positive_supply' && row.supply.totalSupplyAtomic && row.supply.decimals !== null) {
    const whole = scaledDecimalV1(row.supply.totalSupplyAtomic, row.supply.decimals);
    push(
      state,
      'supply',
      address,
      `total supply of ${address}`,
      `${row.supply.totalSupplyAtomic} atomic at ${row.supply.decimals} decimals (${whole} tokens), read at block ${row.supply.blockNumber ?? 'unknown'}`,
    );
    return { missing, sentence: `${whole} tokens are outstanding` };
  }
  if (row.supply.state === 'zero_supply') {
    push(
      state,
      'supply',
      address,
      `total supply of ${address}`,
      `0 atomic at block ${row.supply.blockNumber ?? 'unknown'} — no outstanding position exists to size`,
    );
    return {
      missing,
      sentence: 'no outstanding supply exists, so there is no position to size at this address',
    };
  }
  push(
    state,
    'supply',
    address,
    `total supply of ${address}`,
    `not established (${row.supply.readOutcome}): ${row.supply.reason ?? 'no reason recorded'}`,
  );
  if (row.supply.readOutcome === 'rpc_failure' || row.supply.readOutcome === 'decode_failure') {
    push(
      state,
      'provider_failure',
      address,
      `Miorail's supply read for ${address}`,
      `did not complete (${row.supply.readOutcome}). This is a property of Miorail's read, not of the token.`,
    );
  }
  missing.push(`the outstanding supply of ${address}`);
  return { missing, sentence: 'the outstanding supply is not established' };
}

function quoteItemsV1(
  state: BuilderStateV1,
  row: MarketRealityRepresentationV2,
  response: MarketRealityResponseV2,
  now: Date,
): { missing: string[]; sentence: string } {
  const address = row.tokenAddress;
  const missing: string[] = [];
  const cashDecimals = response.question.cashDecimals;

  for (const source of row.sources) {
    push(
      state,
      'route_status',
      address,
      `${source.source} on ${address}`,
      source.status === 'quoted'
        ? 'answered with a quote'
        : `${source.status}${source.errorCode ? ` (${source.errorCode})` : ''}`,
    );
    if (source.status === 'measurement_failed') {
      push(
        state,
        'provider_failure',
        address,
        `Miorail's ${source.source} call for ${address}`,
        `did not complete${source.errorCode ? ` (${source.errorCode})` : ''}. This is a property of the call, not of the token.`,
      );
    }
  }

  if (row.status === 'full' && row.returnedCashAtomic !== null) {
    const cash = scaledDecimalV1(row.returnedCashAtomic, cashDecimals);
    push(
      state,
      'quote',
      address,
      // BUY spends the cash and SELL receives it. One label for both reads as
      // a return on a purchase, which is a different claim entirely.
      `cash ${response.question.direction === 'buy' ? 'spent' : 'returned'} at the exact size for ${address}`,
      `${row.returnedCashAtomic} atomic USDC (${cash} USDC) on open evidence`,
    );
    if (row.effectivePriceAtomic !== null && row.effectivePriceDecimals !== null) {
      push(
        state,
        'quote',
        address,
        `effective price for ${address}`,
        `${row.effectivePriceAtomic} atomic at ${row.effectivePriceDecimals} decimals (${scaledDecimalV1(row.effectivePriceAtomic, row.effectivePriceDecimals)} USDC per token)`,
      );
    }
    return {
      missing,
      sentence: `the exact size ${response.question.direction === 'buy' ? 'spent' : 'returned'} ${cash} USDC on evidence still open`,
    };
  }

  if (row.lastObservation) {
    const observation = row.lastObservation;
    const age = ageMinutesV1(observation.observedAt, now);
    const cash =
      observation.returnedCashAtomic !== null
        ? `${observation.returnedCashAtomic} atomic USDC (${scaledDecimalV1(observation.returnedCashAtomic, cashDecimals)} USDC)`
        : 'no cash figure';
    push(
      state,
      'observation',
      address,
      `last observation of ${address}`,
      `${observation.status} through ${observation.source}, ${cash}, observed at ${observation.observedAt}, ${age} minutes ago, evidence ${observation.open ? 'still open' : 'expired'}`,
    );
    if (!observation.open) {
      missing.push(`a current cash figure for ${address} — its newest quote expired ${age} minutes ago`);
      return {
        missing,
        sentence: `the newest measurement is ${age} minutes old and its evidence has expired, so it is history rather than a current cost`,
      };
    }
    return { missing, sentence: `the newest measurement through ${observation.source} is ${age} minutes old` };
  }

  missing.push(`any cash figure for ${address} — no reviewed router answered for it`);
  return { missing, sentence: 'no reviewed router answered at the exact size' };
}

function referenceItemsV1(
  state: BuilderStateV1,
  row: MarketRealityRepresentationV2,
): { missing: string[]; sentence: string } {
  const address = row.tokenAddress;
  const missing: string[] = [];
  if (row.reference.valueAtomic !== null && row.reference.decimals !== null) {
    push(
      state,
      'reference',
      address,
      `reference price used for ${address}`,
      `${row.reference.valueAtomic} atomic at ${row.reference.decimals} decimals (${scaledDecimalV1(row.reference.valueAtomic, row.reference.decimals)}) from ${row.reference.referenceSource ?? 'an unnamed source'}, ${row.reference.freshness}, session ${row.reference.marketSession}`,
    );
  } else {
    push(
      state,
      'reference',
      address,
      `reference price used for ${address}`,
      `not established (${row.reference.reasonCode}): ${row.reference.reason ?? 'no reason recorded'}`,
    );
    missing.push(`a reference price for ${address} (${row.reference.reasonCode})`);
  }

  if (row.basis.status === 'comparable' && row.basis.premiumDiscountBps !== null) {
    push(
      state,
      'basis',
      address,
      `premium or discount for ${address}`,
      `${row.basis.premiumDiscountBps} bps against the ${row.basis.kind === 'current_reference' ? 'current' : 'last close'} reference`,
    );
    return {
      missing,
      sentence: `it trades ${row.basis.premiumDiscountBps} bps against its reference`,
    };
  }
  push(
    state,
    'basis',
    address,
    `premium or discount for ${address}`,
    `withheld (${row.basis.reasonCode}): ${row.basis.reason}`,
  );
  missing.push(`a premium or discount for ${address} — the basis is withheld (${row.basis.reasonCode})`);
  return { missing, sentence: `no premium or discount is published, because ${row.basis.reason}` };
}

function historyItemsV1(
  state: BuilderStateV1,
  history: MarketRealityHistoryV1,
  cashDecimals: number,
): string[] {
  const sentences: string[] = [];
  for (const series of history.representations) {
    const quoted = series.points.filter((point) => point.returnedCashAtomic !== null);
    if (quoted.length < 2) continue;
    const first = quoted[0]!;
    const last = quoted[quoted.length - 1]!;
    push(
      state,
      'history',
      series.tokenAddress,
      `earlier point for ${series.tokenAddress} in the ${history.window} window`,
      `${first.returnedCashAtomic} atomic USDC (${scaledDecimalV1(first.returnedCashAtomic!, cashDecimals)} USDC) at ${first.observedAt} through ${first.source}`,
    );
    push(
      state,
      'history',
      series.tokenAddress,
      `later point for ${series.tokenAddress} in the ${history.window} window`,
      `${last.returnedCashAtomic} atomic USDC (${scaledDecimalV1(last.returnedCashAtomic!, cashDecimals)} USDC) at ${last.observedAt} through ${last.source}`,
    );
    sentences.push(
      `for ${series.tokenAddress}, the same exact question returned ${scaledDecimalV1(first.returnedCashAtomic!, cashDecimals)} USDC at ${first.observedAt} and ${scaledDecimalV1(last.returnedCashAtomic!, cashDecimals)} USDC at ${last.observedAt}`,
    );
  }
  return sentences;
}

/**
 * Flattens a market-reality/v2 answer into a citable bundle.
 *
 * `history` is optional and, when present, must be the SAME exact question:
 * two series measured at different sizes are not comparable with each other,
 * and the assembler already refuses to mix them.
 */
export function stocksEvidenceBundleV1(input: {
  question: string;
  reality: MarketRealityResponseV2;
  history?: MarketRealityHistoryV1 | null;
  now: Date;
}): StocksEvidenceBundleV1 {
  const { reality, now } = input;
  const state: BuilderStateV1 = { items: [], next: 1 };
  const missing: string[] = [];

  const cash = scaledDecimalV1(reality.question.requestedCashAtomic, reality.question.cashDecimals);
  push(
    state,
    'question',
    null,
    'the exact question',
    `${reality.question.direction.toUpperCase()} at exactly ${reality.question.requestedCashAtomic} atomic USDC (${cash} USDC) into ${reality.question.destination}, on Base chain ${reality.question.chainId}, for ${reality.question.underlyingKey}`,
  );
  push(
    state,
    'universe',
    null,
    'reviewed representations of this security',
    `${reality.universe.reviewedRepresentationCount} reviewed, ${reality.universe.positiveSupplyRepresentationCount} with outstanding supply, ${reality.universe.zeroSupplyRepresentationCount} with zero supply, ${reality.universe.unresolvedSupplyRepresentationCount} with supply not established`,
  );
  push(
    state,
    'coverage',
    null,
    'market outcome coverage',
    `${reality.marketOutcomeCoverage.establishedOutcomeCount} of ${reality.marketOutcomeCoverage.eligibleRepresentationCount} eligible representations have an established outcome — ${reality.marketOutcomeCoverage.status}${reality.marketOutcomeCoverage.reason ? `: ${reality.marketOutcomeCoverage.reason}` : ''}`,
  );
  push(
    state,
    'coverage',
    null,
    'numeric comparison coverage',
    `${reality.numericComparisonCoverage.pricedRepresentationCount} of ${reality.numericComparisonCoverage.eligibleRepresentationCount} eligible representations are priced on fresh evidence — ${reality.numericComparisonCoverage.status}${reality.numericComparisonCoverage.reason ? `: ${reality.numericComparisonCoverage.reason}` : ''}`,
  );

  const subjects: StocksSubjectV1[] = [];
  const sentences: string[] = [];
  const approvedSources = new Set<string>();

  for (const row of reality.representations) {
    subjects.push({
      tokenAddress: row.tokenAddress,
      issuerId: row.issuerId,
      representationKind: row.representationKind,
    });
    for (const source of row.sources) approvedSources.add(source.source);

    push(
      state,
      'identity',
      row.tokenAddress,
      `representation ${row.tokenAddress}`,
      `issued by ${row.issuerId} as a ${shortKindV1(row.representationKind)}, instrument key ${row.issuerInstrumentKey}`,
    );

    const supply = supplyItemsV1(state, row);
    const quote = quoteItemsV1(state, row, reality, now);
    const reference = referenceItemsV1(state, row);
    missing.push(...supply.missing, ...quote.missing, ...reference.missing);
    sentences.push(
      `${row.tokenAddress} (${row.issuerId}, ${shortKindV1(row.representationKind)}): ${supply.sentence}; ${quote.sentence}; ${reference.sentence}.`,
    );
  }

  if (input.history) {
    sentences.push(...historyItemsV1(state, input.history, reality.question.cashDecimals));
  }

  const measured = reality.representations.filter((row) => row.liveness !== 'never_measured').length;
  const state_ =
    measured === 0
      ? ('not_measured' as const)
      : measured === reality.representations.length
        ? ('measured' as const)
        : ('mixed' as const);

  const providerFailures = state.items.filter((item) => item.kind === 'provider_failure');
  const everyOutcomeIsOurs =
    providerFailures.length > 0 &&
    reality.representations.every((row) =>
      row.sources.every((source) => source.status === 'measurement_failed'),
    );

  const caveats = [
    'A router quote is evidence of a price offered at one block. It is not proof that a trade will fill.',
    'Every figure here is for the exact size in the question. A different size is a different measurement.',
  ];
  if (!reality.representations.some((row) => row.status === 'full')) {
    caveats.push(
      'No representation carries open evidence, so nothing here may be stated as a current cost.',
    );
  }
  if (providerFailures.length > 0) {
    caveats.push(
      'A read of Miorail’s that did not complete is a gap in Miorail, and must not be reported as a property of the token.',
    );
  }

  return {
    question: input.question,
    underlyingKey: reality.question.underlyingKey,
    subjects,
    items: state.items,
    missing,
    caveats,
    approvedSources: [...approvedSources].sort(),
    hasOpenEvidence: reality.representations.some((row) => row.status === 'full'),
    deterministic: sentences.join(' '),
    assertions: {
      state: state_,
      matched: subjects.length,
      complete:
        reality.marketOutcomeCoverage.status === 'complete' &&
        reality.numericComparisonCoverage.status === 'complete',
      incompleteReason: 'targeted_read',
      subjects: subjects.map((subject) => subject.tokenAddress),
      about: everyOutcomeIsOurs ? 'miorail' : providerFailures.length > 0 ? 'mixed' : 'token',
    },
  };
}

/** Every string a narrator may draw a number from. */
export function stocksBundleEvidenceStringsV1(bundle: StocksEvidenceBundleV1): string[] {
  return [
    ...bundle.items.flatMap((item) => [item.label, item.value]),
    ...bundle.missing,
    ...bundle.caveats,
  ];
}

export const STOCKS_CASH_DECIMALS_V1 = USDC_DECIMALS_V1;
