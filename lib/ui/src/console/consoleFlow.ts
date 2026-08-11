import {
  CONSOLE_RAIL_V1,
  consoleFailureCopyV1,
  type AdapterLifecycleV1,
  type ConsoleStepViewV1,
} from './consoleState';

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

export type RouteFamilyV1 = 'swap' | 'earn' | 'commerce' | 'nft' | 'private_ai' | 'unknown';

// Two patterns per family: `\b` is an ASCII word boundary, so it never matches
// before a Cyrillic letter — the RU alternatives are matched without it.
const EARN_PATTERN_V1 = /\b(earn|yield|apy|deposit|supply|lend|lending|stake|staking|moonwell|morpho)/i;
const EARN_PATTERN_RU_V1 = /(разме|доход|застейк|вклад|депозит)/i;
const SWAP_PATTERN_V1 = /\b(swap|trade|exchange|convert)/i;
const SWAP_PATTERN_RU_V1 = /(обмен|своп|поменя)/i;
const COMMERCE_PATTERN_V1 = /\b(buy|gift ?card|top ?up|voucher|bitrefill)/i;
const COMMERCE_PATTERN_RU_V1 = /(купить|подар)/i;
// NFT is checked FIRST because it shares its verb with commerce: "Buy NFT
// BasePaint #123" and "Купи NFT" both match the commerce pattern, and a gift
// card engine handed an NFT goal would search a gift-card catalogue for it.
const NFT_PATTERN_V1 = /\b(nft|opensea|erc-?721|basepaint|collectible)/i;
const NFT_PATTERN_RU_V1 = /(нфт|нft|опенси|опенсea)/i;
// T66. Checked BEFORE the others for the same reason NFT is: an AI goal
// frequently contains another family's verb — "summarise this swap contract",
// "classify these gift cards" — and a summarisation request handed to the swap
// engine would look for a token pair in an essay.
const AI_PATTERN_V1 = /\b(venice|private ai|ask (?:an? )?(?:ai|model|llm)|llm|inference|summari[sz]e|prompt)\b/i;
// `\w` is [A-Za-z0-9_] without the `u` flag, so it never matches a Cyrillic
// suffix — the same trap the `\b` note above describes. The stems are matched
// with an explicit Cyrillic class instead.
const AI_PATTERN_RU_V1 = /(венис|приватн[а-яё]* ии|спроси[а-яё]* (?:у )?(?:ии|модел)|суммир|промпт)/i;

/**
 * Chooses the route family from the goal text so an Earn intent is never sent
 * to the swap engine (and vice versa). Earn wins over swap when both appear —
 * "swap into a yield position" is an earn goal whose swap leg the earn engine
 * owns. Commerce is recognised but not yet routed anywhere.
 */
export function routeFamilyForGoalV1(
  text: string,
  options: { includePrivateAi?: boolean } = {},
): RouteFamilyV1 {
  const value = text.trim();
  if (value.length === 0) return 'unknown';
  // The AI pattern is far greedier than the others — "summarise", "prompt" and
  // "llm" appear inside goals that belong to other families — and it is checked
  // first so a genuine AI request is not swallowed by a shared verb. That
  // ordering is only defensible while the family can actually run. With the
  // gate off the caller passes includePrivateAi: false, and these goals fall
  // through to whichever family CAN serve them.
  if (options.includePrivateAi !== false && (AI_PATTERN_V1.test(value) || AI_PATTERN_RU_V1.test(value))) {
    return 'private_ai';
  }
  if (NFT_PATTERN_V1.test(value) || NFT_PATTERN_RU_V1.test(value)) return 'nft';
  if (COMMERCE_PATTERN_V1.test(value) || COMMERCE_PATTERN_RU_V1.test(value)) return 'commerce';
  if (EARN_PATTERN_V1.test(value) || EARN_PATTERN_RU_V1.test(value)) return 'earn';
  if (SWAP_PATTERN_V1.test(value) || SWAP_PATTERN_RU_V1.test(value)) return 'swap';
  return 'unknown';
}

export interface RouteFamilyDispatchV1 {
  family: RouteFamilyV1;
  /** Which engine may run. null ⟺ nothing runs and the reason explains why. */
  engine: 'swap' | 'earn' | 'commerce' | 'nft' | 'private_ai' | null;
  blockedReason: string | null;
}

export interface ConsoleRouteFlagsV1 {
  routeIntelligenceV1: boolean;
  earnRouteV1: boolean;
  /** T64: commerce COMPARISON. Absent on a pre-T64 server ⟹ off. */
  commerceRouteV1?: boolean;
  /** T64: commerce CHECKOUT, gated separately from comparison. */
  commerceExecutionV1?: boolean;
  /** T65: NFT COMPARISON. Absent on a pre-T65 server ⟹ off. */
  nftRouteV1?: boolean;
  /** T65: NFT PURCHASE, gated separately. Looking at a listing is repeatable;
   * buying the token is not. */
  nftExecutionV1?: boolean;
  /** T66: Private AI COMPARISON. Absent on a pre-T66 server ⟹ off. */
  privateAiRouteV1?: boolean;
  /** T66: Private AI EXECUTION, gated separately. Comparing models sends
   * nothing anywhere; running one sends the prompt to a third party. */
  privateAiExecutionV1?: boolean;
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
  // A disabled family does not get to claim a goal another family can serve.
  // Earn, Commerce and NFT are named by precise nouns, so claiming their goals
  // and reporting the switch is useful. Private AI matches ordinary verbs, so
  // claiming a goal it can never run would turn "summarise how this swap works"
  // into a dead end advertising a feature this deployment does not offer.
  const family = routeFamilyForGoalV1(text, { includePrivateAi: flags.privateAiRouteV1 === true });
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
  if (family === 'nft') {
    return flags.nftRouteV1 === true
      ? { family, engine: 'nft', blockedReason: null }
      : { family, engine: null, blockedReason: 'NFT routing is off on this server. Swap, Earn and Commerce goals still work.' };
  }
  if (family === 'private_ai') {
    return flags.privateAiRouteV1 === true
      ? { family, engine: 'private_ai', blockedReason: null }
      : { family, engine: null, blockedReason: 'Private AI routing is off on this server. Swap, Earn, Commerce and NFT goals still work.' };
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
    nftRouteV1?: boolean;
    nftExecutionV1?: boolean;
    privateAiRouteV1?: boolean;
    privateAiExecutionV1?: boolean;
  };
  rpc?: { status: string; provider: string };
  prices?: { status: string; provider: string };
  risk?: { status: string; provider: string };
  tokenBalances?: { status: string; provider: string };
  chain?: {
    blockNumber: string | null;
    gasPriceGwei: string | null;
    observedAt: string | null;
    gasPoints: Array<{ at: string; gwei: string }>;
    reason: string;
  };
}

// ---------------------------------------------------------------------------
// Chain conditions for the header, footer and sparkline.
//
// These were hardcoded `null` and `[]` in both consoles, so "Block —" said the
// same thing whether the chain was unreachable or the field had never been
// wired. One helper now, used by both surfaces, so they cannot disagree about
// what a dash means.
// ---------------------------------------------------------------------------

/** The block number, or null. Never a stale one: the server refuses to present
 * a previous reading as current, so null here means "not known right now". */
export function chainBlockNumberV1(status: ConsoleServerStatusV1 | null): string | null {
  return status?.chain?.reason === 'ok' ? (status.chain.blockNumber ?? null) : null;
}

/** `0.004 gwei`, or null. The unit is always shown — a bare number in a header
 * is a number nobody can act on. */
export function chainGasLabelV1(status: ConsoleServerStatusV1 | null): string | null {
  const gwei = status?.chain?.reason === 'ok' ? status.chain.gasPriceGwei : null;
  return gwei ? `${gwei} gwei` : null;
}

/** Measured samples for the sparkline, oldest first. Returns [] rather than a
 * single point: one measurement is not a trend, and the screen already has an
 * honest empty state for that case. */
export function chainGasPointsV1(status: ConsoleServerStatusV1 | null): number[] {
  const points = status?.chain?.gasPoints ?? [];
  const values = points
    .map((point) => Number(point.gwei))
    .filter((value) => Number.isFinite(value));
  return values.length > 1 ? values : [];
}

/** Why the chain figures are missing, in words a user can act on. Null when
 * they are present. */
export function chainUnavailableReasonV1(status: ConsoleServerStatusV1 | null): string | null {
  const reason = status?.chain?.reason;
  if (!reason || reason === 'ok') return reason ? null : 'Chain conditions are not reported by this server.';
  if (reason === 'not_configured') return 'No Base RPC is configured, so block and gas are unavailable.';
  if (reason === 'rpc_unreachable') return 'The Base RPC did not answer. Route comparison still works.';
  return 'The Base RPC returned something unreadable. Route comparison still works.';
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
  const nft = flags?.nftRouteV1 === true;
  const nftBuy = flags?.nftExecutionV1 === true;
  const privateAi = flags?.privateAiRouteV1 === true;
  const privateAiRun = flags?.privateAiExecutionV1 === true;
  return [
    {
      action: 'Swap on Base',
      sources: routing ? 'Uniswap, KyberSwap, Aerodrome' : 'route intelligence gate is off',
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
      // Same split as commerce: looking at a listing and buying the token are
      // different switches, and the row says which one is on.
      action: 'NFT purchase (Base, ERC-721)',
      sources: nft
        ? nftBuy
          ? 'OpenSea — compare and buy'
          : 'OpenSea — compare only, purchase gate is off'
        : 'NFT gate is off on this server',
      percent: nft ? (nftBuy ? 35 : 20) : 0,
      state: nft ? (nftBuy ? 'ready' : 'building') : 'off',
      available: nft,
    },
    {
      // Same split again: comparing models and running one are different
      // switches, and the row says which is on.
      action: 'Private AI (Venice)',
      sources: privateAi
        ? privateAiRun
          ? 'Venice — compare and run'
          : 'Venice — compare only, execution gate is off'
        : 'Private AI gate is off on this server',
      percent: privateAi ? (privateAiRun ? 30 : 18) : 0,
      state: privateAi ? (privateAiRun ? 'ready' : 'building') : 'off',
      available: privateAi,
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
  state: AdapterLifecycleV1;
  detail?: string | null;
}

/** The swap adapters this build registers, in rail order. The candidate table
 * uses this to keep a row for an adapter that was never asked. */
export const REGISTERED_SWAP_PROVIDERS_V1 = ['uniswap', 'kyberswap', 'aerodrome'] as const;

/** Which route family each adapter belongs to, so a Commerce comparison never
 * lists a swap adapter it did not and will not call. */
export const ADAPTER_FAMILY_V1: Record<string, RouteFamilyV1 | 'simulation'> = {
  Uniswap: 'swap',
  KyberSwap: 'swap',
  Aerodrome: 'swap',
  'o1.exchange': 'swap',
  Moonwell: 'earn',
  Morpho: 'earn',
  Bitrefill: 'commerce',
  OpenSea: 'nft',
  Venice: 'private_ai',
  'Alchemy simulation': 'simulation',
};

/**
 * Adapter states from the plugin/provider statuses the server reports, plus the
 * route adapters that actually answered this run. Nothing is asserted "live"
 * because the front end believes it should be.
 *
 * T64.3.1: a flag that is off produces `disabled`, not `not_connected`. The
 * two look identical to a user and mean opposite things to an operator.
 */
export function adaptersFromStatusV1(
  status: ConsoleServerStatusV1 | null,
  answered: readonly { name: string }[] = [],
  failed: readonly { name: string; reason?: string }[] = [],
): AdapterStateSourceV1[] {
  const gated = gatedAdaptersV1(status);
  if (answered.length === 0 && failed.length === 0) return gated;

  // T67E §5 — a run REFINES the rail; it does not replace it.
  //
  // This used to return only the adapters that took part in the run, so during
  // a swap comparison Moonwell, Morpho, Bitrefill, OpenSea, Venice and
  // o1.exchange disappeared from a panel titled "Route adapters" — the rail
  // stopped being a source of truth exactly when a user was most likely to
  // consult it. Run outcomes now override the gate-derived state by name, and
  // every other adapter keeps the state its gate gives it.
  const outcome = new Map<string, AdapterStateSourceV1>();
  for (const entry of answered) outcome.set(entry.name, { name: entry.name, state: 'live' });
  for (const entry of failed) {
    outcome.set(entry.name, {
      name: entry.name,
      // It was asked on this run and did not answer. `disabled` is a switch and
      // must never wear this label; `degraded` says it is on and currently
      // failing, which is what actually happened.
      state: 'degraded',
      detail: entry.reason ?? 'last request failed',
    });
  }
  const merged = gated.map((adapter) => outcome.get(adapter.name) ?? adapter);
  const known = new Set(gated.map((adapter) => adapter.name));
  // An adapter that answered but is not in the gate table still gets a row:
  // dropping it would hide a source that demonstrably took part.
  for (const [name, entry] of outcome) if (!known.has(name)) merged.push(entry);
  return merged;
}

function gatedAdaptersV1(status: ConsoleServerStatusV1 | null): AdapterStateSourceV1[] {
  const routing = status?.productMigration.routeIntelligenceV1 === true;
  const earn = status?.productMigration.earnRouteV1 === true;
  const paid = status?.productMigration.paidIntelligence === true;
  const commerce = status?.productMigration.commerceRouteV1 === true;
  const nft = status?.productMigration.nftRouteV1 === true;
  // A registered adapter behind an enabled gate reads as `live` on the rail.
  // The state this fixes was never "enabled vs answered" — it was a switched
  // off flag wearing the same label as a broken connection.
  const gate = (on: boolean): AdapterLifecycleV1 => (on ? 'live' : 'disabled');
  return [
    { name: 'Uniswap', state: gate(routing) },
    { name: 'KyberSwap', state: gate(routing) },
    // T67B: quoted straight from the Aerodrome Router over Base RPC, so it
    // rides the routing gate like the other swap adapters — there is no
    // partner key of its own to be missing.
    { name: 'Aerodrome', state: gate(routing) },
    { name: 'Moonwell', state: gate(earn) },
    { name: 'Morpho', state: gate(earn) },
    { name: 'Alchemy simulation', state: gate(paid) },
    { name: 'Bitrefill', state: gate(commerce) },
    { name: 'OpenSea', state: gate(nft) },
    { name: 'Venice', state: gate(status?.productMigration.privateAiRouteV1 === true) },
    // T67D: the compatibility gate returned `incompatible` on 2026-08-01 — the
    // Trading API requires a raw private key, signTransaction and provider-side
    // broadcast. `planned` would promise an integration that cannot happen
    // without o1 changing its protocol. See
    // docs/research/O1_TRADING_API_COMPATIBILITY.md.
    { name: 'o1.exchange', state: 'blocked' },
  ];
}

// --- T64.3.1: family-aware, terminal Comparing ------------------------------
//
// Two defects this replaces. The first: Comparing listed EVERY adapter for
// every goal, so a Bitrefill gift-card comparison showed Uniswap, KyberSwap,
// Moonwell and Morpho spinning — sources that were never called and never
// would be. The second: when the intent came back `needs_clarification` those
// spinners never stopped, because nothing in the screen knew the run was over.
//
// A terminal reason therefore stops EVERY row here, not in the markup.

export interface ComparingProgressStepV1 {
  label: string;
  state: 'done' | 'running' | 'pending' | 'failed';
  value: string;
  latencyPercent: number;
}

interface FamilyStageLabelsV1 {
  adapter: (name: string) => string;
  evidence: string;
  scoring: string;
}

const FAMILY_STAGE_LABELS_V1: Record<RouteFamilyV1, FamilyStageLabelsV1> = {
  swap: { adapter: (name) => `${name} quote`, evidence: 'Evidence collected', scoring: 'Scoring against your goal' },
  earn: { adapter: (name) => `${name} rates`, evidence: 'Evidence collected', scoring: 'Scoring against your goal' },
  commerce: { adapter: (name) => `${name} catalogue`, evidence: 'Commerce evidence', scoring: 'Commerce scoring' },
  nft: { adapter: (name) => `${name} listing`, evidence: 'NFT evidence', scoring: 'NFT scoring' },
  private_ai: { adapter: (name) => `${name} model catalogue`, evidence: 'Model evidence', scoring: 'Model scoring' },
  unknown: { adapter: (name) => `${name} quote`, evidence: 'Evidence collected', scoring: 'Scoring against your goal' },
};

export interface ComparingProgressInputV1 {
  family: RouteFamilyV1;
  adapters: readonly { name: string; label: string; live: boolean; usable: boolean }[];
  /** Adapter display names that answered on this run. */
  answered: readonly string[];
  /** Non-null once the run is over WITHOUT a route card: needs_clarification,
   * unsupported, a blocked gate, or a transport error. */
  terminalReason: string | null;
  /** Null until evidence has actually been collected. */
  evidenceCount: number | null;
  scored: boolean;
}

/**
 * The Comparing rows for ONE route family.
 *
 * Adapters from other families are not listed at all — not greyed out, not
 * "skipped". They were not part of this comparison, and a row implies they
 * were. Alchemy is absent for the same reason: simulation runs on Review, and
 * a row here would suggest the comparison waited for it.
 */
export function comparingProgressV1(input: ComparingProgressInputV1): ComparingProgressStepV1[] {
  const labels = FAMILY_STAGE_LABELS_V1[input.family];
  const terminal = input.terminalReason !== null;
  const familyAdapters = input.adapters.filter((adapter) => ADAPTER_FAMILY_V1[adapter.name] === input.family);

  const rows: ComparingProgressStepV1[] = [
    { label: 'Intent extraction', state: terminal ? 'failed' : 'done', value: input.family, latencyPercent: 8 },
  ];

  for (const adapter of familyAdapters) {
    const answered = input.answered.includes(adapter.name);
    if (answered) {
      rows.push({ label: labels.adapter(adapter.name), state: 'done', value: 'answered', latencyPercent: 45 });
      continue;
    }
    if (!adapter.usable) {
      rows.push({ label: labels.adapter(adapter.name), state: 'failed', value: adapter.label, latencyPercent: 0 });
      continue;
    }
    rows.push({
      label: labels.adapter(adapter.name),
      // A finished run that produced nothing means this adapter was never
      // reached. It must not keep spinning.
      state: terminal ? 'failed' : 'running',
      value: terminal ? 'not reached' : '',
      latencyPercent: 0,
    });
  }

  rows.push({
    label: labels.evidence,
    state: input.evidenceCount !== null ? 'done' : terminal ? 'failed' : 'pending',
    value: input.evidenceCount !== null ? `${input.evidenceCount} source${input.evidenceCount === 1 ? '' : 's'}` : '',
    latencyPercent: input.evidenceCount !== null ? 18 : 0,
  });
  rows.push({
    label: labels.scoring,
    state: input.scored ? 'done' : terminal ? 'failed' : 'pending',
    value: '',
    latencyPercent: 0,
  });
  return rows;
}

/** What a finished run says when it produced no route card. */
export interface ConsoleTerminalFailureV1 {
  title: string;
  detail: string;
  /**
   * True when `detail` is a QUESTION the server asked, which the user can
   * answer in one word. A question with no way to answer it was the defect:
   * the console asked "which exact Base token should be swapped?" and offered
   * only "Edit goal", so the only way to reply was to retype the sentence.
   *
   * False for a rejection, which is not a question and has no answer field.
   */
  answerable?: boolean;
  /**
   * True when a NEW COMPARISON is what fixes this, so the screen can offer it
   * directly. Route Cards expire with the shortest quote they display — around
   * twenty seconds — and "Back to routes" returned the user to that same
   * expired card, which refused again on the next click. A dead end that
   * loops is worse than one that stops, because it looks like progress.
   *
   * False for `unsupported` and `blocked`: comparing again cannot change an
   * unsupported pair or a Safety Kernel verdict, and offering it would be a
   * button that promises something it cannot do.
   */
  canCompareAgain?: boolean;
}

/** The swap prepare response as it crosses the wire, structurally. */
export type SwapPrepareLikeV1 =
  | { outcome: 'prepared' }
  | { outcome: 'refresh_required'; reason: string; detail: string }
  | { outcome: 'unsupported'; reason: string; detail: string }
  | { outcome: 'blocked'; safety: { blockedReason: string | null } };

/**
 * What the Review screen says when prepare produced no blueprint.
 *
 * Three of the four prepare outcomes carry no calls, and the console read only
 * the fourth. The screen then rendered every check as "not confirmed", zero
 * calls to sign, and a disabled button explained by a line about simulation —
 * none of which was the reason. The server states a reason in each of the three
 * cases and it is carried through verbatim, exactly as the clarification path
 * carries the intent engine's own sentence.
 */
/**
 * When the prepare REQUEST itself failed — a 500, a dropped connection, a
 * timeout — there is no outcome to map, and `swapPrepareNoticeV1` correctly
 * returns null for a body that never arrived. Without this, Review rendered
 * its empty shell with no explanation at all: zero calls, every check "not
 * confirmed", a disabled button, and one sentence about simulation that was
 * not the reason. That is the same defect as reading only the `prepared`
 * branch of the 200 union, one layer further out.
 */
export function swapPrepareRequestFailedNoticeV1(): ConsoleTerminalFailureV1 {
  return {
    title: 'Miorail could not prepare this route',
    detail:
      'The server failed while preparing this transaction. Nothing was signed and nothing was sent. The failure is recorded server-side; comparing again is the safe next step.',
    canCompareAgain: true,
  };
}

export function swapPrepareNoticeV1(
  data: SwapPrepareLikeV1 | null | undefined,
): ConsoleTerminalFailureV1 | null {
  if (!data || data.outcome === 'prepared') return null;
  if (data.outcome === 'refresh_required') {
    return { title: 'This route needs comparing again', detail: data.detail, canCompareAgain: true };
  }
  if (data.outcome === 'unsupported') {
    return { title: 'Miorail cannot prepare this route', detail: data.detail };
  }
  return {
    title: 'The Safety Kernel refused this transaction',
    // A blocked verdict always carries a reason — the schema refuses one that
    // does not — but a null here would otherwise render as an empty warning.
    detail:
      data.safety.blockedReason ??
      'A safety check did not pass, so nothing was prepared for signing.',
  };
}

/** The swap evaluation as it crosses the wire, structurally. */
export type SwapEvaluationLikeV1 =
  | { outcome: 'evaluated' }
  | { outcome: 'needs_clarification'; clarification: { message: string } }
  | { outcome: 'rejected'; issues: readonly { message: string }[] };

/**
 * The swap family's terminal outcomes.
 *
 * This existed for commerce, earn, NFT and private AI and NOT for swap — the
 * one family that is always on. A `needs_clarification` or `rejected` swap
 * finished with no projection, nothing thrown and no failure to show, so the
 * Comparing screen kept its adapter rows spinning forever. Observed with
 * "swap my $mio token", which has no amount in it.
 *
 * The server's own sentence is carried through rather than replaced. It names
 * the missing field; a generic "could not route this" names nothing and leaves
 * the user with no next move.
 */
export function swapTerminalFailureV1(
  data: SwapEvaluationLikeV1 | null | undefined,
): ConsoleTerminalFailureV1 | null {
  if (!data) return null;
  if (data.outcome === 'needs_clarification') {
    return {
      title: 'This goal needs one more detail',
      detail: data.clarification.message,
      answerable: true,
    };
  }
  if (data.outcome === 'rejected') {
    return {
      title: 'Miorail cannot route this swap',
      // Every issue, not just the first: a goal can be short an amount AND name
      // an asset Miorail will not route, and fixing one leaves the other.
      detail: data.issues.map((issue) => issue.message).join(' '),
    };
  }
  return null;
}

/**
 * The stage rail once a run is over without a result. A stage left as `now`
 * keeps claiming to be in progress — on a terminal Comparing screen the rail
 * pointed at "Evidence" indefinitely for work that had already stopped.
 */
export function haltStageRailV1(steps: readonly ConsoleStepViewV1[]): ConsoleStepViewV1[] {
  return steps.map((step) => (step.state === 'now' ? { ...step, state: 'todo' as const } : step));
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

// --- T65.2A: the market rail --------------------------------------------------

/** The market snapshot as it crosses the wire, structurally. */
export type MarketSnapshotLikeV1 =
  | {
      outcome: 'snapshot';
      status: 'live' | 'cached';
      price: string;
      changePercent1h: string | null;
      points: readonly number[];
      observedAt: string;
      provider: string;
    }
  | { outcome: 'unavailable'; reason: string; detail: string };

export interface MarketRailV1 {
  price: { title: string; value: string; change: string; up: boolean; points: number[] } | null;
  unavailableReason: string | null;
}

/** How old a reading is, in words. An age is shown for EVERY snapshot, not
 * only stale ones — a price with no age reads as "now" whether or not it is. */
export function marketAgeLabelV1(observedAt: string, now: Date): string {
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return 'age unknown';
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * The right rail's price panel, from a snapshot or from nothing.
 *
 * A price is shown only when the server actually read one. There is no
 * fallback number and no placeholder chart: an unavailable market renders the
 * server's stated reason, and a snapshot renders its own age and provider so a
 * cached reading cannot pass for a current one.
 */
export function marketRailFromSnapshotV1(
  snapshot: MarketSnapshotLikeV1 | null | undefined,
  now: Date,
  loadingReason = 'Reading the market…',
): MarketRailV1 {
  if (!snapshot) return { price: null, unavailableReason: loadingReason };
  if (snapshot.outcome === 'unavailable') return { price: null, unavailableReason: snapshot.detail };

  const numeric = Number(snapshot.price);
  const value = Number.isFinite(numeric)
    ? `$${numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${snapshot.price}`;
  const change = Number(snapshot.changePercent1h);
  const hasChange = snapshot.changePercent1h !== null && Number.isFinite(change);
  const age = marketAgeLabelV1(snapshot.observedAt, now);

  return {
    price: {
      title: 'ETH / USD',
      value,
      // The change is stated with its window, and its absence is stated too —
      // a missing 1h change must not read as 0%.
      change: `${hasChange ? `${change > 0 ? '+' : ''}${change.toFixed(2)}% · 1h` : 'no 1h change reported'} · ${age} · ${snapshot.provider}`,
      up: hasChange ? change >= 0 : false,
      points: [...snapshot.points],
    },
    unavailableReason: null,
  };
}
