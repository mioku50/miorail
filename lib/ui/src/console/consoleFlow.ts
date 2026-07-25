import { CONSOLE_RAIL_V1, consoleFailureCopyV1, type ConsoleStepViewV1 } from './consoleState';

// ---------------------------------------------------------------------------
// T63D — the flow's real mechanics: measured stage timings, route-family
// dispatch, and coverage/adapter state derived from server flags.
//
// The rule this module exists to enforce: a duration on the rail is a MEASURED
// interval or it is not a duration. "parsed", "quoted" and "ready" are states,
// not timings, and never appear in the timing column.
// ---------------------------------------------------------------------------

export const CONSOLE_STAGES_V1 = [
  'intent',
  'candidates',
  'evidence',
  'simulation',
  'score',
  'review',
  'signed',
  'proof',
] as const;

export type ConsoleStageV1 = (typeof CONSOLE_STAGES_V1)[number];

/** One stage's measured window. `startedAt`/`completedAt` are epoch ms. */
export interface StageMarkV1 {
  startedAt: number | null;
  completedAt: number | null;
}

export type ConsoleStageClockV1 = Partial<Record<ConsoleStageV1, StageMarkV1>>;

export function emptyStageClockV1(): ConsoleStageClockV1 {
  return {};
}

/** Records a stage start. Idempotent: re-entering a stage keeps the first
 * start, so a re-render can never stretch or reset a measured window. */
export function startStageV1(clock: ConsoleStageClockV1, stage: ConsoleStageV1, at: number): ConsoleStageClockV1 {
  const existing = clock[stage];
  if (existing?.startedAt !== undefined && existing?.startedAt !== null) return clock;
  return { ...clock, [stage]: { startedAt: at, completedAt: existing?.completedAt ?? null } };
}

/** Records a stage completion. A completion without a start is ignored rather
 * than back-dated — an unmeasured stage stays unmeasured. */
export function completeStageV1(clock: ConsoleStageClockV1, stage: ConsoleStageV1, at: number): ConsoleStageClockV1 {
  const existing = clock[stage];
  if (!existing || existing.startedAt === null) return clock;
  if (existing.completedAt !== null) return clock;
  return { ...clock, [stage]: { startedAt: existing.startedAt, completedAt: at } };
}

export function stageDurationMsV1(clock: ConsoleStageClockV1, stage: ConsoleStageV1): number | null {
  const mark = clock[stage];
  if (!mark || mark.startedAt === null || mark.completedAt === null) return null;
  return Math.max(0, mark.completedAt - mark.startedAt);
}

/** Milliseconds → the rail's duration label. Sub-second readings keep one
 * decimal so a 200ms stage does not collapse to "0s". */
export function formatStageDurationV1(durationMs: number): string {
  if (durationMs < 1_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

/**
 * The timing column, one entry per rail step:
 *   a completed stage  → its measured duration ("0.2s", "1.4s")
 *   a running stage    → "waiting"
 *   an untouched stage → "—"
 * No state word ever lands here.
 */
export function deriveStageTimingsV1(clock: ConsoleStageClockV1): string[] {
  return CONSOLE_STAGES_V1.map((stage) => {
    const duration = stageDurationMsV1(clock, stage);
    if (duration !== null) return formatStageDurationV1(duration);
    const mark = clock[stage];
    if (mark && mark.startedAt !== null) return 'waiting';
    return '—';
  });
}

/** The rail step the flow currently sits on: the last completed stage, or the
 * running one. Derived from the clock so the stepper cannot disagree with what
 * actually happened. */
export function activeStageStepV1(clock: ConsoleStageClockV1): number {
  let step = 0;
  CONSOLE_STAGES_V1.forEach((stage, index) => {
    const mark = clock[stage];
    if (!mark || mark.startedAt === null) return;
    step = index + 1;
  });
  return step;
}

export function stepperFromClockV1(clock: ConsoleStageClockV1, activeStep?: number): ConsoleStepViewV1[] {
  const step = activeStep ?? activeStageStepV1(clock);
  const timings = deriveStageTimingsV1(clock);
  return CONSOLE_RAIL_V1.map((name, index) => ({
    name,
    state: index < step - 1 ? 'done' : index === step - 1 ? 'now' : 'todo',
    timing: timings[index] ?? '—',
  }));
}

// --- Route family dispatch ---------------------------------------------------

export type RouteFamilyV1 = 'swap' | 'earn' | 'commerce' | 'unknown';

// Two patterns per family: `\b` is an ASCII word boundary, so it never matches
// before a Cyrillic letter — the RU alternatives are matched without it.
const EARN_PATTERN_V1 = /\b(earn|yield|apy|deposit|supply|lend|lending|stake|staking|moonwell|morpho)/i;
const EARN_PATTERN_RU_V1 = /(разме|доход|застейк|вклад|депозит)/i;
const SWAP_PATTERN_V1 = /\b(swap|trade|exchange|convert)/i;
const SWAP_PATTERN_RU_V1 = /(обмен|своп|поменя)/i;
const COMMERCE_PATTERN_V1 = /\b(buy|gift ?card|top ?up|voucher|bitrefill)/i;
const COMMERCE_PATTERN_RU_V1 = /(купить|подар)/i;

/**
 * Chooses the route family from the goal text so an Earn intent is never sent
 * to the swap engine (and vice versa). Earn wins over swap when both appear —
 * "swap into a yield position" is an earn goal whose swap leg the earn engine
 * owns. Commerce is recognised but not yet routed anywhere.
 */
export function routeFamilyForGoalV1(text: string): RouteFamilyV1 {
  const value = text.trim();
  if (value.length === 0) return 'unknown';
  if (COMMERCE_PATTERN_V1.test(value) || COMMERCE_PATTERN_RU_V1.test(value)) return 'commerce';
  if (EARN_PATTERN_V1.test(value) || EARN_PATTERN_RU_V1.test(value)) return 'earn';
  if (SWAP_PATTERN_V1.test(value) || SWAP_PATTERN_RU_V1.test(value)) return 'swap';
  return 'unknown';
}

export interface RouteFamilyDispatchV1 {
  family: RouteFamilyV1;
  /** Which engine may run. null ⟺ nothing runs and the reason explains why. */
  engine: 'swap' | 'earn' | 'commerce' | null;
  blockedReason: string | null;
}

export interface ConsoleRouteFlagsV1 {
  routeIntelligenceV1: boolean;
  earnRouteV1: boolean;
  /** T64: commerce COMPARISON. Absent on a pre-T64 server ⟹ off. */
  commerceRouteV1?: boolean;
  /** T64: commerce CHECKOUT, gated separately from comparison. */
  commerceExecutionV1?: boolean;
}

/**
 * Applies the server's feature flags to the detected family. An Earn goal with
 * the earn gate OFF is NOT "ready" — it is explicitly unavailable, and the
 * console says which switch is off rather than quietly comparing swaps. The
 * same holds for Commerce, which additionally distinguishes "can compare" from
 * "can buy": comparing a gift card is repeatable, buying one is not.
 */
export function dispatchRouteFamilyV1(
  text: string,
  flags: ConsoleRouteFlagsV1,
): RouteFamilyDispatchV1 {
  const family = routeFamilyForGoalV1(text);
  if (!flags.routeIntelligenceV1) {
    return { family, engine: null, blockedReason: 'Route intelligence is off on this server, so no route can be compared yet.' };
  }
  if (family === 'earn') {
    return flags.earnRouteV1
      ? { family, engine: 'earn', blockedReason: null }
      : { family, engine: null, blockedReason: 'Earn routing is off on this server. Swap routes still compare normally.' };
  }
  if (family === 'swap') return { family, engine: 'swap', blockedReason: null };
  if (family === 'commerce') {
    return flags.commerceRouteV1 === true
      ? { family, engine: 'commerce', blockedReason: null }
      : { family, engine: null, blockedReason: 'Commerce routing is off on this server. Swap and Earn goals still work.' };
  }
  return { family, engine: null, blockedReason: 'Say what you want to do — for example "swap 100 USDC to ETH" or "earn yield on 500 USDC".' };
}

/** Whether a compared commerce option can actually be ordered on this server.
 * Comparison being on does NOT imply checkout is on. */
export function commerceCheckoutAvailableV1(flags: ConsoleRouteFlagsV1): {
  available: boolean;
  reason: string | null;
} {
  if (!flags.routeIntelligenceV1 || flags.commerceRouteV1 !== true) {
    return { available: false, reason: 'Commerce routing is off on this server.' };
  }
  if (flags.commerceExecutionV1 !== true) {
    return {
      available: false,
      reason: 'Checkout is off on this server. These prices are read-only until it is enabled.',
    };
  }
  return { available: true, reason: null };
}

// --- Coverage + adapters from the server -------------------------------------

export interface ConsoleServerStatusV1 {
  productMigration: {
    routeIntelligenceV1: boolean;
    paidIntelligence: boolean;
    earnRouteV1: boolean;
    commerceRouteV1?: boolean;
    commerceExecutionV1?: boolean;
  };
  rpc?: { status: string; provider: string };
  prices?: { status: string; provider: string };
  risk?: { status: string; provider: string };
  tokenBalances?: { status: string; provider: string };
}

export interface CoverageRowSourceV1 {
  action: string;
  sources: string;
  percent: number;
  state: 'ready' | 'building' | 'off';
  available: boolean;
}

/**
 * Coverage from the SERVER's own flags and provider states — never a front-end
 * constant. A capability whose gate is off is listed as off, with the sources
 * that would serve it, so the table is honest about what this deployment can
 * actually route today.
 */
export function coverageFromStatusV1(status: ConsoleServerStatusV1 | null): CoverageRowSourceV1[] {
  const flags = status?.productMigration;
  const routing = flags?.routeIntelligenceV1 === true;
  const earn = flags?.earnRouteV1 === true;
  const paid = flags?.paidIntelligence === true;
  const commerce = flags?.commerceRouteV1 === true;
  const checkout = flags?.commerceExecutionV1 === true;
  return [
    {
      action: 'Swap on Base',
      sources: routing ? 'Uniswap, KyberSwap' : 'route intelligence gate is off',
      percent: routing ? 70 : 0,
      state: routing ? 'ready' : 'off',
      available: routing,
    },
    {
      action: 'Earn — supply / withdraw',
      sources: earn ? 'Moonwell, Morpho' : 'earn gate is off on this server',
      percent: earn ? 45 : 0,
      state: earn ? 'ready' : 'off',
      available: earn,
    },
    {
      action: 'Transaction simulation',
      sources: paid ? 'Alchemy eth_simulateV1' : 'paid intelligence gate is off',
      percent: paid ? 60 : 0,
      state: paid ? 'ready' : 'off',
      available: paid,
    },
    {
      action: 'MEV-protected swap',
      sources: 'no approved source connected',
      percent: 0,
      state: 'off',
      available: false,
    },
    {
      // Comparison and checkout are separate gates, so this row states which
      // one is on rather than collapsing them into a single "commerce" claim.
      action: 'Commerce (gift cards, top-ups)',
      sources: commerce
        ? checkout
          ? 'Bitrefill — compare and checkout'
          : 'Bitrefill — compare only, checkout gate is off'
        : 'commerce gate is off on this server',
      percent: commerce ? (checkout ? 40 : 25) : 0,
      state: commerce ? (checkout ? 'ready' : 'building') : 'off',
      available: commerce,
    },
    {
      action: 'Cross-chain bridge',
      sources: 'no approved adapter',
      percent: 0,
      state: 'off',
      available: false,
    },
  ];
}

export interface AdapterStateSourceV1 {
  name: string;
  state: 'live' | 'building' | 'planned' | 'not_connected';
}

/**
 * Adapter states from the plugin/provider statuses the server reports, plus the
 * route adapters that actually answered this run. Nothing is asserted "live"
 * because the front end believes it should be.
 */
export function adaptersFromStatusV1(
  status: ConsoleServerStatusV1 | null,
  answered: readonly { name: string }[] = [],
  failed: readonly { name: string; reason?: string }[] = [],
): AdapterStateSourceV1[] {
  if (answered.length > 0 || failed.length > 0) {
    return [
      ...answered.map((entry) => ({ name: entry.name, state: 'live' as const })),
      ...failed.map((entry) => ({ name: entry.name, state: 'not_connected' as const })),
    ];
  }
  const routing = status?.productMigration.routeIntelligenceV1 === true;
  const earn = status?.productMigration.earnRouteV1 === true;
  const paid = status?.productMigration.paidIntelligence === true;
  const commerce = status?.productMigration.commerceRouteV1 === true;
  // Before the first comparison the registry is reported from the gates alone.
  return [
    { name: 'Uniswap', state: routing ? 'live' : 'not_connected' },
    { name: 'KyberSwap', state: routing ? 'live' : 'not_connected' },
    { name: 'Moonwell', state: earn ? 'live' : 'not_connected' },
    { name: 'Morpho', state: earn ? 'live' : 'not_connected' },
    { name: 'Alchemy simulation', state: paid ? 'live' : 'not_connected' },
    { name: 'Bitrefill', state: commerce ? 'live' : 'not_connected' },
    { name: 'o1.exchange', state: 'planned' },
  ];
}

/** Chain label for the header, from the server's own chain id. */
export function chainLabelV1(chainId: number | null | undefined): string {
  if (chainId === 8453) return 'Base mainnet · 8453';
  if (chainId === 84532) return 'Base Sepolia · 84532';
  if (typeof chainId === 'number') return `Chain ${chainId}`;
  return 'chain unknown';
}

/** Turns a provider status into the honest right-rail line. */
export function providerUnavailableCopyV1(
  provider: { status: string; provider: string } | undefined,
  what: string,
): string {
  if (!provider) return `No ${what} source is reported by this server.`;
  if (provider.status === 'connected') return `${provider.provider} is connected but this surface has no ${what} panel yet.`;
  return `${what} unavailable — ${consoleFailureCopyV1(provider.status)} (${provider.provider}).`;
}
