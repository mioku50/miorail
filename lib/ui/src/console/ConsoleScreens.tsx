import React from 'react';
import {
  CONSOLE_COPY_V1,
  candidateSummaryV1,
  scoredCountLabelV1,
  type CandidateRowViewV1,
  type ConsoleStepViewV1,
  type EvidenceRowViewV1,
  type FreshnessViewV1,
  type ScoreDimensionViewV1,
  type SimulationViewV1,
} from './consoleState';
import type { ProviderDiagnosticRowV1, ProviderHistoryViewV1 } from './consoleAdapters';
import {
  CONSOLE_NO_ANALYSIS_COPY_V1,
  CONSOLE_NO_ANALYSIS_TITLE_V1,
  rightRailHasContentV1,
} from './navigation';
import { BudgetDonut, ConsoleStepper, DepthCurve, RouteGraph, ScoreRadar, ScoreRows, Sparkline, type RouteGraphModelV1 } from './ConsoleCharts';

void React;

// ---------------------------------------------------------------------------
// The five states of ONE flow: plan → comparing → route → review → proof.
// They are steps, not tabs — each screen ends in the CTA that advances the
// route, and the stepper above says where the user is.
// ---------------------------------------------------------------------------

export interface KpiV1 {
  k: string;
  v: string;
  d: string;
  tone?: 'good' | 'warn';
}

function Kpis({ items, two }: { items: readonly KpiV1[]; two?: boolean }) {
  return (
    <div className={`kpis${two ? ' two' : ''}`}>
      {items.map((item) => (
        <div className="kpi" key={item.k}>
          <div className="k">{item.k}</div>
          <div className={`v mono${item.tone ? ` ${item.tone}` : ''}`}>{item.v}</div>
          <div className="d">{item.d}</div>
        </div>
      ))}
    </div>
  );
}

function CandidateTable({
  rows,
  onSelect,
  withAction,
}: {
  rows: readonly CandidateRowViewV1[];
  onSelect?: (id: string) => void;
  withAction: boolean;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Route</th>
          <th>Output</th>
          <th>Net</th>
          <th style={{ width: 100 }}>Score</th>
          <th>Why</th>
          <th className="r">{withAction ? 'Action' : 'State'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="nm">{row.name}</td>
            <td className="mono">{row.outputLabel}</td>
            <td className="mono">{row.netLabel}</td>
            <td>
              <span className={`cmpbar${row.scoreDim ? ' dim' : ''}`}>
                <span style={{ width: `${row.scorePercent}%` }} />
              </span>
            </td>
            {/* An unavailable route keeps its row and states WHY — never hidden. */}
            <td className={row.selectable || row.state === 'chosen' ? undefined : 'off'}>{row.why}</td>
            <td className="r">
              {!withAction ? (
                <span className={row.state === 'unavailable' || row.state === 'blocked' ? 'off' : undefined}>{row.stateLabel}</span>
              ) : row.state === 'chosen' ? (
                <span className="pill br">chosen</span>
              ) : row.selectable && onSelect ? (
                // `onSelect &&`, not `onSelect?.()`. Optional chaining rendered
                // a live-looking button that swallowed the click when no
                // handler was passed — the same dead control the Review button
                // was, one row down.
                <button type="button" className="btn sec" onClick={() => onSelect(row.id)}>
                  Use this
                </button>
              ) : (
                <button type="button" className="btn sec" disabled>
                  {row.actionLabel}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Route (the most important screen) --------------------------------------

export interface RouteScreenModelV1 {
  steps: ConsoleStepViewV1[];
  eyebrow: string;
  amount: string;
  unit: string;
  usd: string;
  providerLabel: string;
  freshness: FreshnessViewV1;
  why: React.ReactNode;
  kpis: KpiV1[];
  graph: RouteGraphModelV1 | null;
  graphUnavailableReason: string | null;
  graphLegend: string[];
  simulatedPill: { label: string; tone: 'g' | 'n' | 'a' };
  scoreRows: ScoreDimensionViewV1[];
  scoringVersion: string;
  /** T67C.1 Part 2. Empty under swap-path-score/v1 — the section then does not
   * render at all, rather than rendering an empty history that a reader could
   * mistake for a measured one. */
  providerHistory?: ProviderHistoryViewV1[];
  candidates: CandidateRowViewV1[];
  onReview: () => void;
  onChangeGoal: () => void;
  onSelectCandidate: (id: string) => void;
  reviewDisabledReason: string | null;
  graphOrientation?: 'horizontal' | 'vertical';
  /** T67E §3 — the same panel the Comparing screen shows. A user who reaches a
   * Route Card still needs to know which providers were not in the comparison
   * behind it, and this is where they look after the fact. */
  diagnostics?: readonly ProviderDiagnosticRowV1[];
  claimHeadline?: string | null;
  onCompareAgain?: () => void;
  comparePending?: boolean;
  /** T67E §1 — token-level panels for the asset this route acquires. A slot
   * rather than a B20-shaped prop: the screen has no business knowing what a
   * B20 control is, and the next token standard will want the same place. */
  tokenPanels?: React.ReactNode;
}

export function RouteScreen(model: RouteScreenModelV1) {
  return (
    <section aria-label="Route card">
      <ConsoleStepper steps={model.steps} />

      <div className="herostrip">
        <div className="heroL">
          <p className="eyebrow">{model.eyebrow}</p>
          <div className="amtrow">
            <span className="amount mono">{model.amount}</span>
            <span className="unit">{model.unit}</span>
            <span className="usd">{model.usd}</span>
            <span style={{ paddingBottom: 6, display: 'flex', gap: 7 }}>
              <span className="pill br">{model.providerLabel}</span>
              <span className={`pill ${model.freshness.tone}`}>{model.freshness.label}</span>
            </span>
          </div>
          <p className="why">{model.why}</p>
        </div>
        <div className="heroR">
          <Kpis items={model.kpis} />
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>Route path</h3>
          <span className="sub">{model.graph ? `split across ${model.graph.pools.length} pool${model.graph.pools.length === 1 ? '' : 's'}` : 'path not available'}</span>
          <span className="rt">
            <span className={`pill ${model.simulatedPill.tone}`}>{model.simulatedPill.label}</span>
          </span>
        </div>
        {model.graph ? (
          <RouteGraph model={model.graph} orientation={model.graphOrientation} />
        ) : (
          <div className="pb">
            <p className="empty">{model.graphUnavailableReason ?? 'The provider did not return a pool breakdown for this route.'}</p>
          </div>
        )}
        {model.graphLegend.length > 0 && (
          <div className="legend">
            {model.graphLegend.map((entry, index) => (
              <span key={entry}>
                {index === 0 && <i />}
                {entry}
              </span>
            ))}
          </div>
        )}
      </div>

      {model.tokenPanels}

      <ProviderDiagnosticsPanel
        rows={model.diagnostics ?? []}
        claimHeadline={model.claimHeadline ?? null}
        onCompareAgain={model.onCompareAgain}
        comparePending={model.comparePending}
      />

      <div className="panel">
        <div className="ph">
          <h3>Path score</h3>
          <span className="sub">{model.scoringVersion}</span>
          <span className="rt">
            <span className="pill n">{scoredCountLabelV1(model.scoreRows)}</span>
          </span>
        </div>
        <div className="pb">
          <div className="scorewrap">
            <ScoreRadar
              rows={model.scoreRows}
              label={`Radar chart. ${model.scoreRows
                .map((row) => `${row.label} ${row.scored ? row.numberLabel : 'not scored'}`)
                .join(', ')}`}
            />
            <ScoreRows rows={model.scoreRows} />
          </div>
        </div>
      </div>

      {(model.providerHistory ?? []).length > 0 && (
        <div className="panel">
          <div className="ph">
            <h3>Provider history</h3>
            <span className="sub">verified routes only</span>
          </div>
          <div className="pb tight">
            {(model.providerHistory ?? []).map((entry) => (
              <div key={entry.providerName} className="note" style={{ marginBottom: 10 }}>
                <b>{entry.providerName}</b>
                <p className="lnote" style={{ margin: '4px 0 8px' }}>{entry.headline}</p>
                <div>
                  {entry.rows.map((row) => (
                    <div className="kv" key={row.label}>
                      <span className="k">{row.label}</span>
                      <span className="v mono">{row.value}</span>
                    </div>
                  ))}
                  <div className="kv">
                    <span className="k">Provider quote</span>
                    <span className="v mono">{entry.quotedResult ?? 'Not available'}</span>
                  </div>
                  <div className="kv">
                    <span className="k">History-adjusted estimate</span>
                    <span className="v mono">{entry.historyAdjustedResult ?? 'Not available'}</span>
                  </div>
                </div>
                {entry.uncalibratedNote && (
                  <p className="lnote" style={{ marginTop: 8 }}>{entry.uncalibratedNote}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="ph">
          <h3>All candidates</h3>
          <span className="sub">{candidateSummaryV1(model.candidates)}</span>
        </div>
        <div className="pb tight">
          <CandidateTable rows={model.candidates} onSelect={model.onSelectCandidate} withAction />
        </div>
      </div>

      <div className="ctarow">
        <button type="button" className="btn lg" onClick={model.onReview} disabled={Boolean(model.reviewDisabledReason)}>
          Review transaction
        </button>
        <button type="button" className="btn sec lg" onClick={model.onChangeGoal}>
          Change goal
        </button>
        <span className="nt">{model.reviewDisabledReason ?? CONSOLE_COPY_V1.nothingSigned}</span>
      </div>
    </section>
  );
}

// --- Comparing ---------------------------------------------------------------

export interface ComparingStepV1 {
  label: string;
  state: 'done' | 'running' | 'pending' | 'failed';
  value: string;
  latencyPercent: number;
}

// ---------------------------------------------------------------------------
// T67E §3 — the provider diagnostics panel.
//
// Every registered swap adapter gets a row on every run: what it returned, why
// it did not, and how old its answer is. Three properties it holds:
//
//   * A failed provider keeps its row. Removing it turns "we compared these
//     three" into a claim about a set the user cannot see.
//   * The reason is the SERVER's typed code translated here — never text
//     scraped from a provider response, and never a raw body.
//   * "Compare again" appears only when the failures are actually retryable.
//     Offering a retry for `not configured` teaches users the button is a lie.
// ---------------------------------------------------------------------------

export interface ProviderDiagnosticsPanelProps {
  rows: readonly ProviderDiagnosticRowV1[];
  /** §3.4: the line that replaces a recommendation when there was no
   * comparison to make. Null when a comparative claim is legitimate. */
  claimHeadline: string | null;
  onCompareAgain?: () => void;
  comparePending?: boolean;
}

export function ProviderDiagnosticsPanel({
  rows,
  claimHeadline,
  onCompareAgain,
  comparePending = false,
}: ProviderDiagnosticsPanelProps) {
  if (rows.length === 0) return null;
  const quoted = rows.filter((row) => row.result === 'quoted').length;
  const retryable = rows.some((row) => row.retryable);
  const explained = rows.filter((row) => row.detail !== null && row.result === 'unavailable');
  return (
    <div className="panel">
      <div className="ph">
        <h3>Providers</h3>
        <span className="sub">
          {quoted} of {rows.length} answered
        </span>
        {onCompareAgain && retryable && (
          <span className="rt">
            <button type="button" className="btn sec" onClick={onCompareAgain} disabled={comparePending}>
              {comparePending ? 'Comparing…' : 'Compare again'}
            </button>
          </span>
        )}
      </div>
      <div className="pb tight">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Result</th>
              <th>Reason</th>
              <th className="r">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const answered = row.result === 'quoted';
              return (
                <tr key={`${row.provider}:${row.result}:${row.reason}`}>
                  <td className={answered ? 'nm' : 'nm off'}>{row.provider}</td>
                  <td className={answered ? 'good' : 'off'}>{answered ? row.output ?? 'quoted' : row.result}</td>
                  <td className={answered ? undefined : 'off'}>{row.reason}</td>
                  <td className={`r mono${answered ? '' : ' off'}`}>{row.age}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* The sentences live below the table rather than inside it: a cell
            wide enough for "what still works and what to do" would squeeze the
            four columns that make the table scannable. */}
        {explained.map((row) => (
          <p className="lnote" key={`why:${row.provider}`}>
            {row.detail}
          </p>
        ))}
        {claimHeadline && (
          <p className="note" style={{ marginTop: 12 }}>
            {claimHeadline}
          </p>
        )}
      </div>
    </div>
  );
}

export interface ComparingScreenModelV1 {
  steps: ConsoleStepViewV1[];
  goalLabel: string;
  optimisingFor: string;
  elapsedLabel: string;
  progress: ComparingStepV1[];
  candidates: CandidateRowViewV1[];
  sources: EvidenceRowViewV1[];
  shortfallNotice: string | null;
  /**
   * T64.3.1 — the run ended without a route card. Set this and the screen
   * becomes terminal: no spinner survives, Candidates says it is finished
   * rather than "updating live", and the user gets a way out.
   */
  failure: { title: string; detail: string } | null;
  onEditGoal: () => void;
  onCancel: () => void;
  /** T67E §3 — one row per registered adapter, with a typed reason. */
  diagnostics?: readonly ProviderDiagnosticRowV1[];
  claimHeadline?: string | null;
  /** §3.5 — a fresh run for the same goal. Never mutates the previous card. */
  onCompareAgain?: () => void;
  comparePending?: boolean;
}

export function ComparingScreen(model: ComparingScreenModelV1) {
  return (
    <section aria-label="Comparing routes">
      <ConsoleStepper steps={model.steps} />
      <div className="panel">
        <div className="ph">
          <h3>{model.goalLabel}</h3>
          <span className="sub">{model.optimisingFor}</span>
          <span className="rt">
            <span className="pill n">{model.elapsedLabel}</span>
            <button type="button" className="btn sec" onClick={model.onCancel}>
              Cancel
            </button>
          </span>
        </div>
        <div className="pb">
          <ul className="lsteps">
            {model.progress.map((step) => (
              <li key={step.label} className={step.state === 'pending' ? 'pending' : undefined}>
                <span className="mk">
                  {step.state === 'done' ? (
                    <span className="ok">✓</span>
                  ) : step.state === 'running' ? (
                    <span className="spin" />
                  ) : step.state === 'failed' ? (
                    <span className="fail">!</span>
                  ) : (
                    <span className="pend" />
                  )}
                </span>
                <span className="lb">{step.label}</span>
                <span className="vl mono">{step.value}</span>
                <span className="lat">
                  {step.latencyPercent > 0 && (
                    <span className="latbar">
                      <span style={{ width: `${step.latencyPercent}%` }} />
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {model.failure && (
            <div className="note warn" role="alert" style={{ marginTop: 14 }}>
              <b>{model.failure.title}</b>
              <p style={{ margin: '6px 0 10px' }}>{model.failure.detail}</p>
              <button type="button" className="btn" onClick={model.onEditGoal}>
                Edit goal
              </button>
            </div>
          )}
          {model.shortfallNotice && <p className="lnote" style={{ marginTop: 12 }}>{model.shortfallNotice}</p>}
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>Candidates so far</h3>
          <span className="sub">{model.failure ? 'finished — no candidates' : 'updating live'}</span>
        </div>
        <div className="pb tight">
          <CandidateTable rows={model.candidates} withAction={false} />
        </div>
      </div>

      <ProviderDiagnosticsPanel
        rows={model.diagnostics ?? []}
        claimHeadline={model.claimHeadline ?? null}
        onCompareAgain={model.onCompareAgain}
        comparePending={model.comparePending}
      />

      <div className="panel">
        <div className="ph">
          <h3>Sources being read</h3>
          <span className="sub">every call is logged into the proof</span>
        </div>
        <div className="pb tight">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Freshness</th>
                <th>Cost</th>
                <th className="r">Result</th>
              </tr>
            </thead>
            <tbody>
              {model.sources.map((source) => (
                <tr key={source.name}>
                  <td className={source.available ? 'nm' : 'nm off'}>{source.name}</td>
                  <td className={source.available ? undefined : 'off'}>{source.kind}</td>
                  <td className={`mono${source.available ? '' : ' off'}`}>{source.freshnessLabel}</td>
                  <td className={`mono${source.available ? '' : ' off'}`}>{source.costLabel}</td>
                  <td className={`r${source.available ? ' good' : ' off'}`}>{source.resultLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// --- Review ------------------------------------------------------------------

export interface ReviewCallV1 {
  index: number;
  title: string;
  detail: string;
  mono?: boolean;
}

export interface BalanceChangeRowV1 {
  asset: string;
  before: string;
  after: string;
  change: string;
  tone: 'good' | 'warn' | 'none';
  note?: string;
}

export interface PreflightCheckV1 {
  label: string;
  passed: boolean;
}

export interface LimitFieldV1 {
  id: string;
  label: string;
  value: string;
  percent: number;
  note: string;
  disabled?: boolean;
}

export interface ReviewScreenModelV1 {
  steps: ConsoleStepViewV1[];
  calls: ReviewCallV1[];
  simulation: SimulationViewV1;
  balanceChanges: BalanceChangeRowV1[];
  balanceUnavailableReason: string | null;
  checks: PreflightCheckV1[];
  limits: LimitFieldV1[];
  onLimitChange: (id: string, value: string) => void;
  onApprove: () => void;
  onBack: () => void;
  approvePending: boolean;
  /** T67E §1 — the same token panels as the Route screen, in full detail. This
   * is the last screen before a signature, so the controls the user is about to
   * be subject to belong here more than anywhere. */
  tokenPanels?: React.ReactNode;
}

export function ReviewScreen(model: ReviewScreenModelV1) {
  const allClear = model.checks.every((check) => check.passed) && model.simulation.passed;
  return (
    <section aria-label="Review transaction">
      <ConsoleStepper steps={model.steps} />

      <div className="cols2" style={{ marginBottom: 14 }}>
        <div className="panel">
          <div className="ph">
            <h3>Calls to sign</h3>
            <span className="sub">{model.calls.length} · one batch</span>
          </div>
          <div className="pb tight">
            {model.calls.map((call) => (
              <div className="call" key={call.index}>
                <span className="cidx">{call.index}</span>
                <div>
                  <div className="ct">{call.title}</div>
                  <div className={`cs${call.mono ? ' mono' : ''}`}>{call.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            <h3>Simulated balance changes</h3>
            <span className="sub">{model.simulation.subLabel}</span>
          </div>
          <div className="pb tight">
            {model.balanceChanges.length === 0 ? (
              <p className="empty">{model.balanceUnavailableReason ?? 'No simulated balance changes are available for this route yet.'}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Before</th>
                    <th>After</th>
                    <th className="r">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {model.balanceChanges.map((row) => (
                    <tr key={row.asset}>
                      <td className="nm">{row.asset}</td>
                      <td className="mono">{row.before}</td>
                      <td className="mono">{row.after}</td>
                      <td className={`r mono${row.tone === 'good' ? ' good' : row.tone === 'warn' ? ' warn' : ''}`}>{row.change}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="ph">
          <h3>Pre-flight</h3>
          <span className="sub">re-runs automatically before you sign</span>
          <span className="rt">
            <span className={`pill ${allClear ? 'g' : 'a'}`}>{allClear ? 'all clear' : model.simulation.subLabel}</span>
          </span>
        </div>
        <div className="pb">
          {/* The simulation block never disappears and never becomes a green
              tick it did not earn. */}
          <div className={`simbox${model.simulation.passed ? '' : ' na'}`} style={{ marginBottom: 16 }}>
            <div className="simhead">
              <span className={model.simulation.passed ? 'ok' : 'fail'}>{model.simulation.passed ? '✓' : '!'}</span>
              {model.simulation.headline}
            </div>
            {model.simulation.detail && <div className="simnote">{model.simulation.detail}</div>}
          </div>
          <div className="checks">
            {model.checks.map((check) => (
              <div key={check.label}>
                <span className={`tick${check.passed ? '' : ' na'}`}>{check.passed ? '✓' : '·'}</span>
                <span>
                  {check.label}
                  {!check.passed && ' — not confirmed'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {model.tokenPanels}

      {/* Only when something on this review can actually be charged. An empty
          budget panel on a free comparison is a control asking to be
          configured for a payment that will never be requested. */}
      {model.limits.length > 0 && (
      <div className="panel">
        <div className="ph">
          <h3>Your limits</h3>
          <span className="sub">edit here — no separate settings page</span>
        </div>
        <div className="pb">
          <div className="limits">
            {model.limits.map((limit) => (
              <div key={limit.id}>
                <label htmlFor={limit.id}>{limit.label}</label>
                <input
                  id={limit.id}
                  value={limit.value}
                  disabled={limit.disabled}
                  onChange={(event) => model.onLimitChange(limit.id, event.target.value)}
                />
                <div className="usebar">
                  <span style={{ width: `${limit.percent}%` }} />
                </div>
                <div className="lnote">{limit.note}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}

      <div className="ctarow">
        <button
          type="button"
          className="btn lg"
          onClick={model.onApprove}
          disabled={!model.simulation.canSign || model.approvePending}
        >
          {model.approvePending ? 'Waiting for Base Account…' : 'Approve in Base Account'}
        </button>
        <button type="button" className="btn sec lg" onClick={model.onBack}>
          Back to routes
        </button>
        <span className="nt">{model.simulation.disabledReason ?? CONSOLE_COPY_V1.prepared}</span>
      </div>
    </section>
  );
}

// --- Proof -------------------------------------------------------------------

export interface TimelineEntryV1 {
  title: string;
  detail: string;
  done?: boolean;
}

export interface PlanVsActualRowV1 {
  label: string;
  expected: string;
  actual: string;
  difference: string;
  tone: 'good' | 'warn' | 'none';
}

export interface ProofScreenModelV1 {
  steps: ConsoleStepViewV1[];
  eyebrow: string;
  amount: string;
  unit: string;
  usd: string;
  headlinePill: { label: string; tone: 'g' | 'a' | 'n' };
  why: string;
  kpis: KpiV1[];
  timeline: TimelineEntryV1[];
  planVsActual: PlanVsActualRowV1[];
  record: { label: string; value: string; dim?: boolean }[];
  onExport: () => void;
  onNewGoal: () => void;
}

export function ProofScreen(model: ProofScreenModelV1) {
  return (
    <section aria-label="Route proof">
      <ConsoleStepper steps={model.steps} />
      <div className="herostrip">
        <div className="heroL">
          <p className="eyebrow">{model.eyebrow}</p>
          <div className="amtrow">
            <span className="amount mono">{model.amount}</span>
            <span className="unit">{model.unit}</span>
            <span className="usd">{model.usd}</span>
            <span style={{ paddingBottom: 6 }}>
              <span className={`pill ${model.headlinePill.tone}`}>{model.headlinePill.label}</span>
            </span>
          </div>
          <p className="why">{model.why}</p>
        </div>
        <div className="heroR">
          <Kpis items={model.kpis} two />
        </div>
      </div>

      <div className="cols2">
        <div className="panel">
          <div className="ph">
            <h3>Execution timeline</h3>
          </div>
          <div className="pb">
            <ul className="tl">
              {model.timeline.map((entry) => (
                <li key={entry.title} className={entry.done ? 'g' : undefined}>
                  <div className="tt">{entry.title}</div>
                  <div className="ts mono">{entry.detail}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="panel">
          <div className="ph">
            <h3>Plan vs actual</h3>
          </div>
          <div className="pb tight">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Expected</th>
                  <th>Actual</th>
                  <th className="r">Difference</th>
                </tr>
              </thead>
              <tbody>
                {model.planVsActual.map((row) => (
                  <tr key={row.label}>
                    <td className="nm">{row.label}</td>
                    <td className="mono">{row.expected}</td>
                    <td className="mono">{row.actual}</td>
                    <td className={`r mono${row.tone === 'good' ? ' good' : row.tone === 'warn' ? ' warn' : ''}`}>{row.difference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="ph">
          <h3>Record</h3>
          <span className="sub">immutable · exportable as JSON</span>
          <span className="rt">
            <button type="button" className="btn sec" onClick={model.onExport}>
              Export proof
            </button>
            <button type="button" className="btn" onClick={model.onNewGoal}>
              New goal
            </button>
          </span>
        </div>
        <div className="pb tight">
          <table>
            <tbody>
              {model.record.map((row) => (
                <tr key={row.label}>
                  <td className="nm" style={{ width: 220 }}>
                    {row.label}
                  </td>
                  <td className={row.dim ? 'off' : undefined}>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// --- Plan --------------------------------------------------------------------

export interface CoverageRowV1 {
  action: string;
  sources: string;
  percent: number;
  state: 'ready' | 'building' | 'off';
  available: boolean;
}

export interface WalletBalanceRowV1 {
  asset: string;
  amount: string;
  usd: string;
}

export interface PlanScreenModelV1 {
  goal: string;
  onGoalChange: (value: string) => void;
  onCompare: () => void;
  comparePending: boolean;
  compareDisabledReason: string | null;
  starters: { id: string; title: string; meta: string; disabled?: boolean }[];
  onStarter: (id: string) => void;
  walletLabel: string | null;
  balances: WalletBalanceRowV1[];
  balancesUnavailableReason: string | null;
  coverage: CoverageRowV1[];
  chainKpis: KpiV1[];
  gasPoints: number[];
  chainNote: string;
}

export function PlanScreen(model: PlanScreenModelV1) {
  return (
    <section aria-label="New goal">
      <div className="panel">
        <div className="ph">
          <h3>New goal</h3>
          <span className="sub">Base mainnet</span>
          <span className="rt">
            <span className="pill n">{CONSOLE_COPY_V1.nothingPrepared}</span>
          </span>
        </div>
        <div className="pb">
          <label htmlFor="mio-goal" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Describe your goal
          </label>
          <textarea
            id="mio-goal"
            rows={3}
            className="goalinput"
            placeholder="Swap 100 USDC to ETH with the best net result"
            value={model.goal}
            onChange={(event) => model.onGoalChange(event.target.value)}
          />
          <div className="ctarow" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn lg"
              onClick={model.onCompare}
              // T64.3.1: when there is a reason this goal cannot be compared,
              // the button is DISABLED. It used to stay bright and simply do
              // nothing on click, which reads as a broken console rather than
              // as a route family that is switched off.
              disabled={model.comparePending || model.goal.trim().length === 0 || model.compareDisabledReason !== null}
            >
              {model.comparePending ? 'Comparing…' : 'Compare routes'}
            </button>
            <span className="nt">{model.compareDisabledReason ?? CONSOLE_COPY_V1.planHint}</span>
          </div>
        </div>
      </div>

      <div className="cols2">
        <div className="panel">
          <div className="ph">
            <h3>Start from</h3>
          </div>
          <div className="pb tight">
            {model.starters.map((starter) => (
              <button
                key={starter.id}
                type="button"
                className="item"
                onClick={() => model.onStarter(starter.id)}
                disabled={starter.disabled}
              >
                <span className="t">{starter.title}</span>
                <span className="m">{starter.meta}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="ph">
            <h3>Your wallet</h3>
            <span className="sub mono">{model.walletLabel ?? 'not connected'}</span>
          </div>
          <div className="pb tight">
            {model.balances.length === 0 ? (
              <p className="empty">{model.balancesUnavailableReason ?? CONSOLE_COPY_V1.portfolioUnavailable}</p>
            ) : (
              <table>
                <tbody>
                  {model.balances.map((row) => (
                    <tr key={row.asset}>
                      <td className="nm">{row.asset}</td>
                      <td className="mono">{row.amount}</td>
                      <td className="r off">{row.usd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="cols2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="ph">
            <h3>What Miorail can route today</h3>
            <span className="sub">coverage is explicit, never implied</span>
          </div>
          <div className="pb tight">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Sources</th>
                  <th style={{ width: 96 }}>Coverage</th>
                  <th className="r">State</th>
                </tr>
              </thead>
              <tbody>
                {model.coverage.map((row) => (
                  <tr key={row.action}>
                    <td className="nm">{row.action}</td>
                    <td className={row.available ? undefined : 'off'}>{row.sources}</td>
                    <td>
                      <span className={`cmpbar${row.available ? '' : ' dim'}`}>
                        <span style={{ width: `${row.percent}%` }} />
                      </span>
                    </td>
                    <td className={`r${row.state === 'ready' ? ' good' : ' off'}`}>{row.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel">
          <div className="ph">
            <h3>Chain conditions</h3>
            <span className="sub">Base mainnet · last 60 min</span>
          </div>
          <div className="pb">
            <div style={{ marginBottom: 14 }}>
              <Kpis items={model.chainKpis} />
            </div>
            {model.gasPoints.length > 1 ? (
              <Sparkline points={model.gasPoints} gradientId="mio-gg" height={64} label="Gas price over the last hour" />
            ) : (
              <p className="empty">Gas history is not available right now. Route comparison still works.</p>
            )}
            <div className="lnote" style={{ marginTop: 8 }}>
              {model.chainNote}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// --- Right rail panels -------------------------------------------------------

export interface RightRailModelV1 {
  price: { title: string; value: string; change: string; up: boolean; points: number[] } | null;
  priceUnavailableReason: string | null;
  depth: { markerPercent: number; note: string } | null;
  depthUnavailableReason: string | null;
  evidenceFeed: { id: string; time: string; source: string; text: string; available: boolean }[];
  spend: { percent: number; amount: string; capLabel: string; rows: { label: string; value: string }[] } | null;
  /**
   * Whether THIS route family can be charged at all.
   *
   * False hides the Intelligence spend panel outright rather than showing an
   * empty budget. Swap comparison is free — the paid surface moved to the B20
   * exit proof — so a budget panel on a swap asked the user to configure a
   * ceiling for a charge that can never happen, and printed the B20 price
   * ($0.0002) next to a swap as if it were about to be spent.
   */
  paidSurfaceActive?: boolean;
  freshness: { label: string; value: string; tone?: 'ok' | 'off' }[];
}

export function ConsoleRightRail(model: RightRailModelV1) {
  // T70 §7 — before a goal runs, all five panels are empty. Stacked down a
  // 330px column that reads as five separate failures ("Pool depth
  // unavailable", "No evidence", "No spend", "Freshness unknown"), when it is
  // one fact: nothing has been asked yet. Said once, and the panels come back
  // the moment there is anything in them.
  if (!rightRailHasContentV1(model)) {
    return (
      <div className="rp">
        <div className="rph">{CONSOLE_NO_ANALYSIS_TITLE_V1}</div>
        <div className="rpb">
          <p className="empty">{CONSOLE_NO_ANALYSIS_COPY_V1}</p>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="rp">
        <div className="rph">
          {model.price?.title ?? 'Price'}
          <span className="rt">1h</span>
        </div>
        <div className="rpb">
          {model.price ? (
            <>
              <div className="bigv mono">{model.price.value}</div>
              <div className={`subv${model.price.up ? ' good' : ''}`}>{model.price.change}</div>
              <Sparkline points={model.price.points} gradientId="mio-sg" label={`${model.price.title} over the last hour`} />
            </>
          ) : (
            <p className="empty">{model.priceUnavailableReason ?? 'No price source connected.'}</p>
          )}
        </div>
      </div>

      <div className="rp">
        <div className="rph">
          Pool depth
          <span className="rt">paid source</span>
        </div>
        <div className="rpb">
          {model.depth ? (
            <>
              <DepthCurve
                markerPercent={model.depth.markerPercent}
                label="Depth curve with your trade size marked inside available liquidity"
              />
              <div className="subv" style={{ marginTop: 6 }}>
                {model.depth.note}
              </div>
            </>
          ) : (
            <p className="empty">{model.depthUnavailableReason ?? 'No depth source connected — liquidity is not scored.'}</p>
          )}
        </div>
      </div>

      <div className="rp">
        <div className="rph">
          Evidence stream
          <span className="rt">live</span>
        </div>
        <div className="rpb">
          {model.evidenceFeed.length === 0 ? (
            <p className="empty">No evidence recorded yet for this goal.</p>
          ) : (
            <ul className="feed">
              {model.evidenceFeed.map((entry) => (
                <li key={entry.id} className={entry.available ? undefined : 'off'}>
                  <span className="tm mono">{entry.time}</span>
                  <span>
                    <span className="src">{entry.source}</span> {entry.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {model.paidSurfaceActive !== false && (
      <div className="rp">
        <div className="rph">
          Intelligence spend
          <span className="rt">this goal</span>
        </div>
        <div className="rpb">
          {model.spend ? (
            <>
              <div className="donutwrap">
                <BudgetDonut percent={model.spend.percent} label={`${model.spend.percent} percent of the intelligence budget used`} />
                <div>
                  <div className="bigv mono">{model.spend.amount}</div>
                  <div className="subv">{model.spend.capLabel}</div>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                {model.spend.rows.map((row) => (
                  <div className="qrow" key={row.label}>
                    <span>{row.label}</span>
                    <span className="v mono">{row.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="empty">{CONSOLE_COPY_V1.limitsMissing}</p>
          )}
        </div>
      </div>
      )}

      <div className="rp">
        <div className="rph">
          Freshness
          <span className="rt">auto-refresh</span>
        </div>
        <div className="rpb">
          {model.freshness.map((row) => (
            <div className="qrow" key={row.label}>
              <span>{row.label}</span>
              <span className={`v mono${row.tone === 'ok' ? ' ok' : row.tone === 'off' ? ' off' : ''}`}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
