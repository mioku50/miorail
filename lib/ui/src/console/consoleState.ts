// ---------------------------------------------------------------------------
// Miorail Console — pure view model.
//
// lib/ui never imports api-spec/api-zod/route-domain, so every source type here
// is STRUCTURAL: the real wire objects are assignable to them. This module owns
// the console's honesty rules, and they are unit-tested rather than left to the
// components:
//
//   * empty is never good — an unavailable source becomes a visible row with a
//     reason, never a dropped row;
//   * an unscored dimension is never 0 and never green — it renders as a hatched
//     track, a dashed radar axis and the words "not scored";
//   * freshness is always on screen, and a quote older than the threshold turns
//     amber;
//   * nothing claims to be signed until the user signs.
// ---------------------------------------------------------------------------

export type ConsoleScreenV1 = 'plan' | 'comparing' | 'route' | 'review' | 'proof';

/** The eight steps of ONE route. These are not tabs: the user moves along them. */
export const CONSOLE_RAIL_V1: readonly string[] = [
  'Intent',
  'Candidates',
  'Evidence',
  'Simulation',
  'Score',
  'Review',
  'Signed',
  'Proof',
];

/** Which rail step each screen sits on (1-based; 0 = not started). */
export const CONSOLE_SCREEN_STEP_V1: Record<ConsoleScreenV1, number> = {
  plan: 0,
  comparing: 4,
  route: 5,
  review: 6,
  proof: 8,
};

export interface ConsoleStepViewV1 {
  name: string;
  state: 'done' | 'now' | 'todo';
  timing: string;
}

/** Builds the 8-step rail. `timings` is sparse on purpose — a step nobody has
 * measured yet shows an em dash rather than a fabricated duration. */
export function deriveStepperV1(
  activeStep: number,
  timings: readonly (string | null)[] = [],
): ConsoleStepViewV1[] {
  return CONSOLE_RAIL_V1.map((name, index) => ({
    name,
    state: index < activeStep - 1 ? 'done' : index === activeStep - 1 ? 'now' : 'todo',
    timing: timings[index] ?? '—',
  }));
}

/** Compact miniapp label for the same rail: "Step 5 of 8 · Score". */
export function compactStepLabelV1(activeStep: number): string {
  if (activeStep <= 0) return `Not started · ${CONSOLE_RAIL_V1.length} steps`;
  const name = CONSOLE_RAIL_V1[Math.min(activeStep, CONSOLE_RAIL_V1.length) - 1];
  return `Step ${activeStep} of ${CONSOLE_RAIL_V1.length} · ${name}`;
}

export const CONSOLE_BREADCRUMB_V1: Record<ConsoleScreenV1, (goal: string) => string[]> = {
  plan: () => ['Session', 'New goal'],
  comparing: (goal) => ['Session', goal, 'Comparing'],
  route: (goal) => ['Session', goal, 'Route card'],
  review: (goal) => ['Session', goal, 'Review'],
  proof: (goal) => ['Proofs', goal],
};

// --- Microcopy --------------------------------------------------------------

/**
 * Every string a reviewer checks for, in one place. The rule these follow: a
 * failure message must say what STILL works and what to do next. "X is blocked
 * until Y passes readiness checks" does not pass review.
 */
export const CONSOLE_COPY_V1 = {
  readOnly: 'Read-only until you approve',
  nothingSigned: 'Still nothing signed.',
  prepared: 'Miorail prepared these calls. Base Account executes them.',
  nothingPrepared: 'nothing prepared',
  planHint: 'Miorail reads quotes and simulates. No transaction is prepared.',
  /** One adapter answered out of two. */
  oneAdapterQuoted: "Uniswap didn't answer. Comparing 1 of 2 routes.",
  walletDisconnected: 'Connect your wallet to prepare this swap. Miorail can compare routes without it.',
  // Says what is true and what still works. The old wording — "it takes one
  // field" — promised a field that existed nowhere: the Budget drawer rendered
  // a status and no control at all, so anyone who followed the instruction
  // found a dead end and no explanation.
  limitsMissing: 'No spending permission yet, so paid checks are off. Free route comparison is unaffected.',
  recipientMissing: 'Miorail will only send to your own wallet unless you add another address.',
  portfolioUnavailable: 'Balances didn’t load. Route comparison still works.',
  notScored: 'not scored · no source',
  dashedAxis: 'dashed axis = no source',
  simulationUnavailable: 'Simulation is not available yet, so nothing is signed from a guess.',
} as const;

/** Turns a raw backend/adapter reason into a sentence that keeps the honest
 * "what still works" shape. Unknown reasons are humanized, never hidden. */
export function consoleFailureCopyV1(reason: string | null | undefined): string {
  if (!reason) return 'No reason reported.';
  const known: Record<string, string> = {
    no_adapter: 'No adapter — this route is not built yet.',
    not_connected: 'Not connected — connect the source to include this route.',
    manifest_missing: 'Manifest missing — the plugin has not been registered.',
    provider_not_configured: 'Not configured on the server. Route comparison still works.',
    wallet_disconnected: CONSOLE_COPY_V1.walletDisconnected,
    portfolio_unavailable: CONSOLE_COPY_V1.portfolioUnavailable,
    limits_missing: CONSOLE_COPY_V1.limitsMissing,
    recipient_missing: CONSOLE_COPY_V1.recipientMissing,
    // T64.3.1 — commerce intent issues. These end a comparison, so each one
    // has to say what to change rather than name a code.
    not_commerce_goal: 'This does not read as a purchase. Try “buy a $5 Steam gift card”.',
    product_required: 'Name the product to buy — for example “Steam”, “Amazon” or “Uber”.',
    amount_required: 'Say the card value, for example “$5”.',
    conflicting_amounts: 'Two different card values were named. Keep one.',
    conflicting_limits: 'Two different spending limits were named. Keep one.',
    limit_currency_unsupported: 'The spending limit has to be in USD or USDC — this rail settles in USDC.',
    limit_below_denomination: 'The spending limit is below the card value, so nothing could be bought within it.',
    currency_ambiguous: 'Say the currency, for example “$5” or “5 USD”.',
    country_required: 'Say the market, for example “a US Steam card”.',
    kind_ambiguous: 'Say whether this is a gift card, a top-up or an eSIM.',
    recipient_required: 'A top-up needs the phone number to credit.',
    yo_route_adapter_not_released:
      'YO belongs in Routes, but its typed APY, liquidity, withdrawal and execution adapter has not passed release gates yet. No Moonwell or Morpho route was substituted.',
    balancer_earn_adapter_not_released:
      'Balancer belongs in Routes, but its Earn/liquidity adapter has not passed release gates yet. No Moonwell or Morpho route was substituted.',
    hydrex_earn_adapter_not_released:
      'Hydrex belongs in Routes, but its Earn/liquidity adapter has not passed release gates yet. No Moonwell or Morpho route was substituted.',
  };
  return known[reason] ?? humanizeConsoleTokenV1(reason);
}

export function humanizeConsoleTokenV1(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

// --- Freshness --------------------------------------------------------------

/** Past this the quote pill turns amber. Freshness is never off-screen. */
export const CONSOLE_STALE_QUOTE_SECONDS_V1 = 45;

export interface FreshnessViewV1 {
  label: string;
  tone: 'n' | 'a';
  stale: boolean;
}

export function quoteFreshnessV1(
  ageSeconds: number | null,
  staleAfter: number = CONSOLE_STALE_QUOTE_SECONDS_V1,
): FreshnessViewV1 {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) {
    return { label: 'quote age unknown', tone: 'a', stale: true };
  }
  const age = Math.max(0, Math.floor(ageSeconds));
  const stale = age > staleAfter;
  return { label: `quote ${age}s`, tone: stale ? 'a' : 'n', stale };
}

export function ageLabelV1(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return '—';
  const age = Math.max(0, Math.floor(ageSeconds));
  if (age < 60) return `${age}s`;
  const minutes = Math.floor(age / 60);
  return `${minutes}m ${age % 60}s`;
}

// --- Score ------------------------------------------------------------------

export interface ScoreDimensionSourceV1 {
  key: string;
  label: string;
  /** null ⟺ not scored. NEVER substitute 0. */
  score: number | null;
  /** Shown under the number: sources + freshness, or why it is not scored. */
  confidence: string | null;
  notScoredReason?: string | null;
}

export interface ScoreDimensionViewV1 {
  key: string;
  label: string;
  scored: boolean;
  score: number | null;
  /** Percentage width for the track; 0 when not scored (the track is hatched). */
  width: number;
  numberLabel: string;
  confidenceLabel: string;
}

export function deriveScoreRowsV1(dimensions: readonly ScoreDimensionSourceV1[]): ScoreDimensionViewV1[] {
  return dimensions.map((dimension) => {
    const scored = dimension.score !== null && Number.isFinite(dimension.score);
    return {
      key: dimension.key,
      label: dimension.label,
      scored,
      score: scored ? dimension.score : null,
      width: scored ? Math.max(0, Math.min(100, Math.round(dimension.score as number))) : 0,
      numberLabel: scored ? String(Math.round(dimension.score as number)) : '—',
      confidenceLabel: scored
        ? dimension.confidence ?? 'scored'
        : dimension.notScoredReason ?? CONSOLE_COPY_V1.notScored,
    };
  });
}

export function scoredCountLabelV1(rows: readonly ScoreDimensionViewV1[]): string {
  const scored = rows.filter((row) => row.scored).length;
  return `${scored} of ${rows.length} dimensions scored`;
}

/** Radar geometry for N axes. The unscored axes are returned separately so the
 * component can draw them dashed to the centre instead of pretending a value. */
export interface RadarGeometryV1 {
  gridRings: string[];
  shape: string;
  points: { x: number; y: number; scored: boolean }[];
  labels: { x: number; y: number; text: string; scored: boolean }[];
  unscoredAxes: { x1: number; y1: number; x2: number; y2: number }[];
}

export function radarGeometryV1(
  rows: readonly ScoreDimensionViewV1[],
  options: { cx?: number; cy?: number; radius?: number } = {},
): RadarGeometryV1 {
  const cx = options.cx ?? 60;
  const cy = options.cy ?? 58;
  const radius = options.radius ?? 46;
  const count = Math.max(rows.length, 3);
  const angle = (index: number) => (Math.PI * 2 * index) / count - Math.PI / 2;
  const at = (index: number, r: number) => ({
    x: Number((cx + Math.cos(angle(index)) * r).toFixed(1)),
    y: Number((cy + Math.sin(angle(index)) * r).toFixed(1)),
  });

  const ring = (scale: number) =>
    rows
      .map((_row, index) => {
        const point = at(index, radius * scale);
        return `${point.x},${point.y}`;
      })
      .join(' ');

  const points = rows.map((row, index) => {
    const point = at(index, row.scored ? (radius * row.width) / 100 : 0);
    return { ...point, scored: row.scored };
  });

  const labels = rows.map((row, index) => {
    const point = at(index, radius + 12);
    return { ...point, text: row.label, scored: row.scored };
  });

  const unscoredAxes = rows.flatMap((row, index) => {
    if (row.scored) return [];
    const outer = at(index, radius);
    return [{ x1: cx, y1: cy, x2: outer.x, y2: outer.y }];
  });

  return {
    gridRings: [ring(1), ring(0.66), ring(0.33)],
    shape: points.map((point) => `${point.x},${point.y}`).join(' '),
    points,
    labels,
    unscoredAxes,
  };
}

// --- Candidates -------------------------------------------------------------

export interface CandidateSourceV1 {
  id: string;
  name: string;
  /** null ⟺ this route produced no quote; the row still renders. */
  output: string | null;
  net: string | null;
  scorePercent: number | null;
  why: string;
  state: 'chosen' | 'available' | 'unavailable' | 'blocked' | 'simulating' | 'leading';
  /** Required whenever state is unavailable/blocked — the row must explain itself. */
  reason?: string | null;
}

export interface CandidateRowViewV1 {
  id: string;
  name: string;
  outputLabel: string;
  netLabel: string;
  scorePercent: number;
  scoreDim: boolean;
  why: string;
  state: CandidateSourceV1['state'];
  stateLabel: string;
  selectable: boolean;
  actionLabel: string;
}

const CANDIDATE_STATE_LABELS_V1: Record<CandidateSourceV1['state'], string> = {
  chosen: 'chosen',
  leading: 'leading',
  available: 'available',
  simulating: 'simulating',
  unavailable: 'Unavailable',
  blocked: 'Blocked',
};

/**
 * Rows for the candidate table. Unavailable routes are NOT filtered out — they
 * stay visible with their reason, because a missing row reads as "we compared
 * everything", which would be a lie.
 */
export function deriveCandidateRowsV1(candidates: readonly CandidateSourceV1[]): CandidateRowViewV1[] {
  return candidates.map((candidate) => {
    const quotable = candidate.output !== null;
    return {
      id: candidate.id,
      name: candidate.name,
      outputLabel: candidate.output ?? '—',
      netLabel: candidate.net ?? '—',
      scorePercent: quotable ? Math.max(0, Math.min(100, Math.round(candidate.scorePercent ?? 0))) : 0,
      scoreDim: candidate.state !== 'chosen' && candidate.state !== 'leading',
      why: quotable ? candidate.why : candidate.reason ?? candidate.why,
      state: candidate.state,
      stateLabel: CANDIDATE_STATE_LABELS_V1[candidate.state],
      selectable: quotable && candidate.state !== 'chosen',
      actionLabel:
        candidate.state === 'chosen'
          ? 'chosen'
          : candidate.state === 'blocked'
            ? 'Blocked'
            : quotable
              ? 'Use this'
              : 'Unavailable',
    };
  });
}

export function candidateSummaryV1(rows: readonly CandidateRowViewV1[]): string {
  const quotable = rows.filter((row) => row.outputLabel !== '—').length;
  return `${rows.length} considered · ${quotable} quotable`;
}

/** "Uniswap didn't answer. Comparing 1 of 2 routes." — assembled from the real
 * adapter set, never hardcoded to one provider. */
export function adapterShortfallCopyV1(
  adapters: readonly { name: string; answered: boolean }[],
): string | null {
  const missing = adapters.filter((adapter) => !adapter.answered);
  if (missing.length === 0 || adapters.length === 0) return null;
  const names = missing.map((adapter) => adapter.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? "didn't" : "didn't";
  return `${list} ${verb} answer. Comparing ${adapters.length - missing.length} of ${adapters.length} routes.`;
}

// --- Evidence / sources -----------------------------------------------------

export interface EvidenceSourceRowV1 {
  name: string;
  kind: string;
  /** null = the source never answered. */
  freshness: string | null;
  /** Cost is ALWAYS shown — 'free' or a price. Never blank. */
  cost: string | null;
  result: 'ok' | 'running' | 'unavailable';
  reason?: string | null;
}

export interface EvidenceRowViewV1 {
  name: string;
  kind: string;
  freshnessLabel: string;
  costLabel: string;
  resultLabel: string;
  available: boolean;
}

export function deriveEvidenceRowsV1(sources: readonly EvidenceSourceRowV1[]): EvidenceRowViewV1[] {
  return sources.map((source) => ({
    name: source.name,
    kind: source.result === 'unavailable' ? source.reason ?? '—' : source.kind,
    freshnessLabel: source.freshness ?? '—',
    costLabel: source.cost ?? '—',
    resultLabel: source.result === 'ok' ? 'ok' : source.result === 'running' ? '…' : source.reason ?? 'no source',
    available: source.result !== 'unavailable',
  }));
}

/** Total intelligence spend label, from the rows themselves. */
export function intelligenceSpendLabelV1(sources: readonly EvidenceSourceRowV1[]): string {
  let total = 0;
  let paid = 0;
  for (const source of sources) {
    const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(source.cost ?? '');
    if (!match) continue;
    total += Number(match[1]);
    paid += 1;
  }
  const amount = total === 0 ? '$0' : `$${total.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `${amount} · ${paid} paid call${paid === 1 ? '' : 's'}`;
}

// --- Simulation -------------------------------------------------------------

export interface SimulationSourceV1 {
  status: 'passed' | 'failed' | 'unavailable';
  provider: string | null;
  blockNumber: string | null;
  ageSeconds: number | null;
  gasUsed: string | null;
  reason?: string | null;
}

export interface SimulationViewV1 {
  available: boolean;
  passed: boolean;
  headline: string;
  detail: string;
  subLabel: string;
  /** The signing CTA is disabled unless a simulation actually passed. */
  canSign: boolean;
  disabledReason: string | null;
}

/**
 * The Review screen's simulation block. It NEVER disappears and NEVER turns
 * into a green tick when the adapter is missing: an unavailable simulation is
 * stated as such.
 *
 * `serverAllowsSigning` is the Safety Kernel's verdict, and it is the ONLY
 * thing that may enable the CTA. This screen used to decide by itself —
 * "no simulation, no signing" — which sounds prudent and was wrong in both
 * directions:
 *
 *   - The server already ran that rule. `simulation_evidence` is a Safety
 *     Kernel CHECK, so a route that needs simulation and lacks it comes back
 *     `blocked` and never reaches Review at all. Aerodrome, whose calldata
 *     this server writes, is exactly that case.
 *   - For a partner-built route at standard depth the server's answer is that
 *     signing is fine without a fork simulation, and it says so in
 *     `simulationHonesty`. The screen overrode it, so with the paid
 *     simulation path off — its default — NO swap could ever be signed. That
 *     is what the user hit: every check green, Approve dead.
 *
 * A simulation that RAN and REVERTED still vetoes below, whatever the server
 * says: that is evidence, not an absence of it.
 */
export function deriveSimulationViewV1(
  simulation: SimulationSourceV1 | null,
  serverAllowsSigning = false,
): SimulationViewV1 {
  if (!simulation || simulation.status === 'unavailable') {
    const reason = simulation?.reason ?? null;
    return {
      available: false,
      passed: false,
      headline: 'Simulation not available',
      detail: reason
        ? `${consoleFailureCopyV1(reason)} Route comparison and the calls above are unchanged.`
        : 'No simulation provider answered. Route comparison and the calls above are unchanged.',
      subLabel: 'not available',
      canSign: serverAllowsSigning,
      disabledReason: serverAllowsSigning ? null : CONSOLE_COPY_V1.simulationUnavailable,
    };
  }
  if (simulation.status === 'failed') {
    return {
      available: true,
      passed: false,
      headline: 'Simulation reverted on Base mainnet 8453',
      detail: `${simulation.provider ?? 'The provider'} ran these calls against live state and they reverted. Nothing was signed — change the route or the amount and try again.`,
      subLabel: simulation.provider ?? 'simulation',
      canSign: false,
      disabledReason: 'This route reverts in simulation, so it cannot be signed.',
    };
  }
  return {
    available: true,
    passed: true,
    headline: 'Simulation passed on Base mainnet 8453',
    detail: '',
    subLabel: `${simulation.provider ?? 'simulation'} · ${ageLabelV1(simulation.ageSeconds)} ago`,
    canSign: true,
    disabledReason: null,
  };
}

// --- Left rail --------------------------------------------------------------

/**
 * T64.3.1 — the five states an adapter can actually be in. The old model had
 * one bucket, `not_connected`, and used it for two unrelated situations: a
 * feature flag the operator deliberately switched off, and a provider that was
 * asked and could not answer. Calling a disabled Earn gate "not connected"
 * sent the operator hunting for a broken RPC that was never broken.
 *
 *   disabled        — a server flag is off. Nothing was attempted.
 *   configured      — enabled and ready, but it has not been asked yet.
 *   live            — it answered on this run.
 *   preflight_failed— it was asked on this run and could not answer.
 *   planned         — no adapter exists yet.
 */
export type AdapterLifecycleV1 =
  | 'live'
  | 'configured'
  | 'preflight_failed'
  // T67E §5: it is switched on and its last request failed. Distinct from
  // `preflight_failed`, which is a refusal BEFORE any request, and from
  // `disabled`, which is a switch. A degraded adapter is expected to recover.
  | 'degraded'
  | 'disabled'
  | 'planned'
  // T67D: a compatibility gate ran and returned incompatible. Distinct from
  // `planned`, which promises the integration is coming, and from `disabled`,
  // which says a switch is off. This one means the provider's own protocol
  // cannot be reached from Miorail's execution path — and only the provider can
  // change that.
  | 'blocked';

export const ADAPTER_LIFECYCLE_LABELS_V1: Record<AdapterLifecycleV1, string> = {
  live: 'live',
  configured: 'configured',
  preflight_failed: 'preflight failed',
  degraded: 'degraded',
  disabled: 'disabled',
  planned: 'planned',
  blocked: 'blocked',
};

export interface AdapterStatusSourceV1 {
  name: string;
  state: AdapterLifecycleV1;
  /** Why it is in this state, when the state alone does not say. Shown beside
   * `degraded` and `preflight_failed`, where "it failed" without "at what" is
   * not actionable. */
  detail?: string | null;
}

export interface AdapterStatusViewV1 {
  name: string;
  label: string;
  state: AdapterLifecycleV1;
  /** It answered on this run. Only `live` earns the green tick. */
  live: boolean;
  /** It is switched on and could answer. Drives the "n / m" summary, so a
   * configured-but-not-yet-asked adapter is not reported as missing. */
  usable: boolean;
  detail: string | null;
}

export function deriveAdapterRowsV1(adapters: readonly AdapterStatusSourceV1[]): {
  rows: AdapterStatusViewV1[];
  summary: string;
} {
  const rows = adapters.map((adapter) => ({
    name: adapter.name,
    // A degraded adapter says what failed on the same line: "degraded · last
    // request failed" is a state a user can act on; "degraded" alone is not.
    label: adapter.detail
      ? `${ADAPTER_LIFECYCLE_LABELS_V1[adapter.state]} · ${adapter.detail}`
      : ADAPTER_LIFECYCLE_LABELS_V1[adapter.state],
    state: adapter.state,
    live: adapter.state === 'live',
    usable: adapter.state === 'live' || adapter.state === 'configured',
    detail: adapter.detail ?? null,
  }));
  // T67E §4: `blocked` is excluded from the NUMERATOR — `usable` already does
  // that — and stays in the denominator. It is listed on the rail, so hiding it
  // from the count would make the ratio disagree with the rows underneath it.
  const usable = rows.filter((row) => row.usable).length;
  return { rows, summary: `${usable} / ${rows.length}` };
}

export function usagePercentV1(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

// --- Route proof -------------------------------------------------------------

/** The fields of `RouteProofProjectionV1` this view needs, structurally. */
export interface RouteProofSourceV1 {
  proofId: string;
  finalStatus: 'pending' | 'completed' | 'partial_failure' | 'failed' | 'cancelled' | 'reconciliation_required';
  actualOutput: string | null;
  actualOutputUnavailableReason: 'native_output_unverifiable' | 'not_reconciled' | null;
  expectedOutput: { amountAtomic: string; asset: { symbol: string; decimals: number } };
  actualGas: { gasUnits: string } | null;
  receipts: readonly { blockNumber: string | null }[];
}

export interface RouteProofViewV1 {
  /** Null when the chain's answer cannot be read, never a guess. */
  actualOutputDecimal: string | null;
  /** Why it is null — a sentence, shown where the number would be. */
  actualOutputReason: string;
  statusLabel: string;
  statusTone: 'g' | 'n' | 'a';
  blockNumber: string | null;
}

/** Base units to a human decimal. Exact: string arithmetic, never a float. */
function atomicToDecimalV1(value: string, decimals: number): string | null {
  if (!/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The proof screen's values, read from the projection the server actually
 * sends.
 *
 * The console used to cast the response to a shape with `proofHash`, `status`,
 * `actualOutput.amountDecimal`, `actualGasUsed` and `blockNumber` — none of
 * which exist on it. Every read came back undefined, so a completed swap
 * displayed em dashes and a green "reconciled" pill that was only the `??`
 * fallback, while the response carried the gas, the block and the receipt all
 * along.
 */
export function routeProofViewV1(proof: RouteProofSourceV1): RouteProofViewV1 {
  const actualOutputDecimal = proof.actualOutput
    ? atomicToDecimalV1(proof.actualOutput, proof.expectedOutput.asset.decimals)
    : null;
  const statusTone: RouteProofViewV1['statusTone'] =
    proof.finalStatus === 'completed' ? 'g' : proof.finalStatus === 'failed' ? 'a' : 'n';
  return {
    actualOutputDecimal,
    // A native output emits no ERC-20 Transfer log, so there is nothing to read
    // and Miorail declines to invent a figure. That is a different statement
    // from "we tried and failed", and the screen must not blur them.
    actualOutputReason:
      proof.actualOutputUnavailableReason === 'native_output_unverifiable'
        ? `${proof.expectedOutput.asset.symbol} is the chain's native asset and emits no transfer log, so the amount received cannot be read from the receipt`
        : 'not reconciled yet',
    statusLabel: proof.finalStatus.replace(/_/g, ' '),
    statusTone,
    blockNumber: proof.receipts.find((receipt) => receipt.blockNumber)?.blockNumber ?? null,
  };
}
