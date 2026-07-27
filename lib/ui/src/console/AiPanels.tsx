import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// T66C — the Private AI screens: Route Card, Review, Result and Proof.
//
// Presentational only, and structurally typed: these components describe the
// SHAPE of a card and a proof rather than importing the Zod contracts, so
// lib/ui stays free of route-domain.
//
// The class vocabulary is the console's own — `panel`, `qrow`, `cr-*`,
// `scorerow`, `pill`. These panels invent none of their own. That rule exists
// because the NFT panels shipped with invented classes no stylesheet defined
// and reached production as a wall of run-together words; consoleStyles.test.ts
// now fails the build if it happens again.
//
// The other rule, specific to this family: NOTHING HERE RENDERS A PROMPT. The
// components are not given one. `dataSentSummary` is a sentence the server
// built from the commitment's shape, and the answer is passed to the Result
// panel alone — the Proof panel has no prop that could carry it.
// ---------------------------------------------------------------------------

export interface AiCandidateLikeV1 {
  modelId: string;
  modelName: string;
  privacyMode: 'private' | 'anonymized' | 'unknown';
  estimatedCostUsd: string;
  contextTokens: number;
  offline: boolean;
  ineligibleReason: string | null;
  capabilities: {
    supportsToolCalling: boolean | null;
    supportsResponseSchema: boolean | null;
    supportsWebSearch: boolean | null;
  };
}

export interface AiDimensionLikeV1 {
  dimension: string;
  score: number | null;
  notScoredReason: string | null;
}

export interface AiRouteCardLikeV1 {
  status: string;
  recommendation: string;
  selectionPolicy: string;
  taskKind: string;
  selected: AiCandidateLikeV1 | null;
  alternatives: readonly AiCandidateLikeV1[];
  dimensions: readonly AiDimensionLikeV1[];
  evidenceGaps: readonly string[];
  dataSentSummary: string;
  retentionClaim: string | null;
  unsupportedCapabilities: readonly string[];
  maxSpendUsd: string;
  estimatedCostUsd: string | null;
  x402Metered: boolean;
  failureReason: string | null;
  routeCardHash: string;
  expiresAt: string;
}

export interface AiProofLikeV1 {
  proofHash: string;
  modelId: string;
  modelVersion: string | null;
  privacyMode: 'private' | 'anonymized' | 'unknown';
  promptCommitment: string;
  responseHash: string;
  responseChars: number;
  finishReason: string;
  schemaValidation: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    actualCostUsd: string | null;
    latencyMs: number;
  };
  x402Metered: boolean;
  estimatedCostUsd: string;
  finalStatus: string;
  failureReason: string | null;
  observedAt: string;
}

/** A hash, shortened for a line of prose. The full value goes in `title`. */
export function shortAiHashV1(value: string | null): string {
  if (!value) return '—';
  return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/** USD, at the precision the number actually has. A rate of $0.0000376 must
 * not render as "$0.00" — at these sizes the leading zeros are the story. */
export function usdLabelV1(value: string | null): string {
  if (value === null) return 'Not reported';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `$${value}`;
  if (numeric === 0) return '$0';
  if (numeric < 0.01) return `$${value.replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${numeric.toFixed(2)}`;
}

/**
 * The privacy mode in words, ATTRIBUTED.
 *
 * Every label names Venice as the source, because that is all a mode value is
 * — the provider's own claim about its own service. An earlier draft rendered
 * `private` as "Private — not retained", which asserted a retention guarantee
 * the mode does not carry and directly contradicted the Retention row beside
 * it when no policy was published. Retention is its own field, and it says
 * "not stated" when nothing was stated.
 */
export const AI_PRIVACY_LABEL_V1: Record<AiCandidateLikeV1['privacyMode'], string> = {
  private: 'Venice private mode',
  anonymized: 'Venice anonymised mode — no account identity',
  unknown: 'Not stated by the provider',
};

const INELIGIBLE_COPY_V1: Record<string, string> = {
  not_allowlisted: 'not on this server’s allowlist',
  offline: 'reported offline',
  privacy_mode_insufficient: 'privacy mode is below what you required',
  context_too_small: 'context is too small for this request',
  missing_tool_calling: 'no tool calling',
  missing_response_schema: 'no structured output',
  missing_web_search: 'no web search',
  over_spend_ceiling: 'costs more than your limit',
  pricing_unavailable: 'no published price',
};

export function aiIneligibleCopyV1(reason: string | null): string {
  if (reason === null) return 'eligible';
  return INELIGIBLE_COPY_V1[reason] ?? reason.replace(/_/g, ' ');
}

function Row({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="qrow" title={title}>
      <span>{label}</span>
      <span className="v mono">{value}</span>
    </div>
  );
}

/** One model, as a card row. Used for the selection and for every alternative,
 * so a rejected model is presented with the same weight as the chosen one. */
export function AiModelRow({ candidate }: { candidate: AiCandidateLikeV1 }) {
  const eligible = candidate.ineligibleReason === null;
  return (
    <div className="cardrow">
      <div className="cr-top">
        <span className="cr-name">{candidate.modelName}</span>
        <span className={`pill ${eligible ? 'g' : 'a'}`}>
          {eligible ? candidate.privacyMode : aiIneligibleCopyV1(candidate.ineligibleReason)}
        </span>
      </div>
      <div className="cr-nums">
        <div>
          <span className="cr-k">Est. cost</span>
          <span className="cr-v mono">{usdLabelV1(candidate.estimatedCostUsd)}</span>
        </div>
        <div>
          <span className="cr-k">Context</span>
          <span className="cr-v mono">{candidate.contextTokens.toLocaleString('en-US')}</span>
        </div>
      </div>
      <p className="cr-why mono">{candidate.modelId}</p>
    </div>
  );
}

export interface AiRouteCardPanelProps {
  card: AiRouteCardLikeV1;
  onReview?: () => void;
  reviewDisabledReason?: string | null;
}

export function AiRouteCardPanel({ card, onReview, reviewDisabledReason }: AiRouteCardPanelProps) {
  const { selected } = card;

  if (selected === null) {
    // A comparison that chose nothing still shows what it considered. Removing
    // the models from the screen would leave the user unable to tell "nothing
    // matched" from "every match was too expensive".
    return (
      <div className="panel" aria-label="Private AI route card">
        <div className="ph">
          <h3>Private AI route</h3>
          <span className="rt">
            <span className="pill a">no model selected</span>
          </span>
        </div>
        <div className="pb">
          <p className="why warn">
            {card.failureReason ?? 'Every model in the catalogue was refused for this request.'}
          </p>
          {card.alternatives.length > 0 && (
            <>
              <div className="sechead">
                <span>Considered</span>
                <span>{card.alternatives.length} models</span>
              </div>
              {card.alternatives.map((candidate) => (
                <AiModelRow key={candidate.modelId} candidate={candidate} />
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="panel" aria-label="Private AI route card">
      <div className="ph">
        <h3>Private AI route</h3>
        <span className="rt">
          <span className="pill n">{card.taskKind.replace(/_/g, ' ')}</span>
          <span className={`pill ${selected.privacyMode === 'private' ? 'g' : 'a'}`}>{selected.privacyMode}</span>
        </span>
      </div>
      <div className="pb">
        <AiModelRow candidate={selected} />

        {/* One provider's catalogue is not the whole market, and the sentence
            says which comparison was actually run. */}
        <p className="why">{card.recommendation}</p>

        <div className="cr-nums" style={{ marginTop: 12 }}>
          <div>
            <span className="cr-k">Estimated cost</span>
            <span className="cr-v mono">{usdLabelV1(card.estimatedCostUsd)}</span>
          </div>
          <div>
            <span className="cr-k">Your limit</span>
            <span className="cr-v mono">{usdLabelV1(card.maxSpendUsd)}</span>
          </div>
        </div>

        {/* What leaves the machine, stated before anything is sent. */}
        <div className="sechead">
          <span>What is sent</span>
          <span>before you approve</span>
        </div>
        <p className="why">{card.dataSentSummary}</p>
        <Row label="Privacy mode" value={AI_PRIVACY_LABEL_V1[selected.privacyMode]} />
        <Row
          label="Retention"
          // A missing claim reads as "not stated", never as "not retained".
          value={card.retentionClaim ?? 'Not stated by the provider'}
        />
        <Row label="Paid by" value={card.x402Metered ? 'x402 — metered per request' : 'this server’s Venice account'} />

        {card.unsupportedCapabilities.length > 0 && (
          <Row label="This model cannot" value={card.unsupportedCapabilities.join(', ')} />
        )}

        <div className="sechead">
          <span>Scoring</span>
          <span>no combined number</span>
        </div>
        {card.dimensions.map((dimension) => {
          const scored = dimension.score !== null;
          return (
            <div key={dimension.dimension} className={`scorerow${scored ? '' : ' na'}`}>
              <span className="nm">{dimension.dimension.replace(/_/g, ' ')}</span>
              {/* An unscored dimension keeps its hatched track and says why —
                  it never renders as a zero. */}
              <span className={`track${scored ? '' : ' na'}`}>
                {scored && <span style={{ width: `${Math.max(0, Math.min(100, dimension.score as number))}%` }} />}
              </span>
              <span className="nu">{scored ? dimension.score : '—'}</span>
              <span className="cf">
                {scored ? '' : `not scored · ${dimension.notScoredReason?.replace(/_/g, ' ') ?? 'no source'}`}
              </span>
            </div>
          );
        })}
        <p className="lnote">{card.selectionPolicy}</p>

        {card.alternatives.length > 0 && (
          <>
            <div className="sechead">
              <span>Alternatives</span>
              <span>{card.alternatives.length} considered</span>
            </div>
            {card.alternatives.map((candidate) => (
              <AiModelRow key={candidate.modelId} candidate={candidate} />
            ))}
          </>
        )}

        {card.evidenceGaps.length > 0 && (
          <p className="lnote">Not established: {card.evidenceGaps.join(', ').replace(/_/g, ' ')}</p>
        )}

        {onReview && (
          <button type="button" className="btn sec" onClick={onReview} disabled={Boolean(reviewDisabledReason)}>
            Review request
          </button>
        )}
        {reviewDisabledReason && <p className="lnote">{reviewDisabledReason}</p>}
      </div>
    </div>
  );
}

export interface AiReviewPanelProps {
  card: AiRouteCardLikeV1;
  /** The commitment, shown so the user can see the request is pinned. The
   * prompt itself is not a prop of this component. */
  promptCommitment: string;
  runnable: boolean;
  blockedReason: string | null;
  /** The "Run on Venice" control, passed in rather than built here so this
   * package stays presentational. */
  runSlot?: ReactNode;
}

export function AiReviewPanel({
  card,
  promptCommitment,
  runnable,
  blockedReason,
  runSlot,
}: AiReviewPanelProps) {
  const selected = card.selected;
  return (
    <div className="panel" aria-label="Private AI request review">
      <div className="ph">
        <h3>Review this request</h3>
        <span className="rt">
          <span className={`pill ${runnable ? 'g' : 'a'}`}>{runnable ? 'ready to run' : 'blocked'}</span>
        </span>
      </div>
      <div className="pb">
        {selected && <AiModelRow candidate={selected} />}

        <div className="cr-nums" style={{ marginTop: 12 }}>
          <div>
            <span className="cr-k">You may spend</span>
            <span className="cr-v mono">{usdLabelV1(card.maxSpendUsd)}</span>
          </div>
          <div>
            <span className="cr-k">Estimated</span>
            <span className="cr-v mono">{usdLabelV1(card.estimatedCostUsd)}</span>
          </div>
        </div>

        <p className="why">{card.dataSentSummary}</p>
        <Row label="Model" value={selected?.modelId ?? '—'} />
        <Row label="Privacy mode" value={selected ? AI_PRIVACY_LABEL_V1[selected.privacyMode] : '—'} />
        <Row label="Retention" value={card.retentionClaim ?? 'Not stated by the provider'} />
        <Row label="Billing" value={card.x402Metered ? 'x402 — metered per request' : 'this server’s Venice account'} />
        {card.unsupportedCapabilities.length > 0 && (
          <Row label="Not supported" value={card.unsupportedCapabilities.join(', ')} />
        )}
        <Row label="Request commitment" value={shortAiHashV1(promptCommitment)} title={promptCommitment} />
        <Row label="Route Card hash" value={shortAiHashV1(card.routeCardHash)} title={card.routeCardHash} />
        <Row label="Card expires" value={card.expiresAt} />

        {/* Running is offered only when every gate passed. A disabled control
            with a stated reason beats one that fails after the click. */}
        <div className="ctarow" style={{ marginTop: 12 }}>
          {runnable ? runSlot : <span className="nt">{blockedReason ?? 'This request cannot be run yet.'}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The headline for each outcome.
 *
 * `completed` is the ONLY one that says the request succeeded. A truncated or
 * refused answer gets its own sentence, because a user who paid for a cut-off
 * response is entitled to be told that is what happened.
 */
export const AI_RESULT_HEADLINE_V1: Record<string, string> = {
  pending: 'The model has not finished answering.',
  completed: 'Answer received and verified against this request.',
  truncated: 'The answer was cut off at the token limit you set.',
  refused: 'The model declined to answer this request.',
  failed: 'This request did not produce a usable answer.',
};

export function aiResultHeadlineV1(finalStatus: string): string {
  return AI_RESULT_HEADLINE_V1[finalStatus] ?? 'This request has no recorded outcome.';
}

/**
 * The answer itself.
 *
 * Deliberately a SEPARATE panel from the proof. The answer is returned once
 * and stored nowhere; the proof is stored and contains none of it. Keeping
 * them in one component would invite a future edit that persists the panel's
 * props and quietly stores the completion with them.
 */
export function AiResultPanel({ text, finalStatus }: { text: string; finalStatus: string }) {
  return (
    <div className="panel" aria-label="Private AI answer">
      <div className="ph">
        <h3>Answer</h3>
        <span className="rt">
          <span className={`pill ${finalStatus === 'completed' ? 'g' : 'a'}`}>{finalStatus}</span>
        </span>
      </div>
      <div className="pb">
        <p className="why">
          <b>{aiResultHeadlineV1(finalStatus)}</b>
        </p>
        {text.length > 0 ? (
          <pre className="mono aitext">{text}</pre>
        ) : (
          // The server did not keep a copy, so a reload cannot show one. Saying
          // so is more honest than an empty box.
          <p className="lnote">
            This answer was returned once and was not stored. Re-running would be a new request and a new charge.
          </p>
        )}
      </div>
    </div>
  );
}

export function AiProofPanel({ proof }: { proof: AiProofLikeV1 }) {
  const tone = proof.finalStatus === 'completed' ? 'g' : proof.finalStatus === 'pending' ? 'n' : 'a';
  const { usage } = proof;
  return (
    <div className="panel" aria-label="Private AI route proof">
      <div className="ph">
        <h3>AI route proof</h3>
        <span className="rt">
          <span className={`pill ${tone}`}>{proof.finalStatus.replace(/_/g, ' ')}</span>
        </span>
      </div>
      <div className="pb">
        <p className="why">
          <b>{aiResultHeadlineV1(proof.finalStatus)}</b>
        </p>

        <div className="cr-nums">
          <div>
            <span className="cr-k">Actually charged</span>
            <span className="cr-v mono">{usdLabelV1(usage.actualCostUsd)}</span>
          </div>
          <div>
            {/* The estimate stays beside the charge. A card said one number and
                the provider billed another; both belong on the proof. */}
            <span className="cr-k">Was estimated</span>
            <span className="cr-v mono">{usdLabelV1(proof.estimatedCostUsd)}</span>
          </div>
        </div>

        <Row label="Model" value={proof.modelId} />
        <Row label="Model version" value={proof.modelVersion ?? 'Not published'} />
        <Row label="Privacy mode" value={AI_PRIVACY_LABEL_V1[proof.privacyMode]} />
        <Row label="Prompt tokens" value={usage.promptTokens ?? 'Not reported'} />
        <Row label="Completion tokens" value={usage.completionTokens ?? 'Not reported'} />
        <Row label="Total tokens" value={usage.totalTokens ?? 'Not reported'} />
        <Row label="Latency" value={`${usage.latencyMs} ms`} />
        <Row label="Finish reason" value={proof.finishReason.replace(/_/g, ' ')} />
        <Row
          label="Schema check"
          value={
            proof.schemaValidation === 'not_requested'
              ? 'No schema was requested'
              : proof.schemaValidation === 'passed'
                ? 'Answer matched the requested shape'
                : 'Answer did not match the requested shape'
          }
        />
        <Row label="Answer length" value={`${proof.responseChars} characters`} />
        <Row label="Billing" value={proof.x402Metered ? 'x402 — metered per request' : 'this server’s Venice account'} />
        <Row
          label="Request commitment"
          value={shortAiHashV1(proof.promptCommitment)}
          title={proof.promptCommitment}
        />
        <Row label="Response hash" value={shortAiHashV1(proof.responseHash)} title={proof.responseHash} />
        <Row label="Proof hash" value={shortAiHashV1(proof.proofHash)} title={proof.proofHash} />
        <Row label="Observed at" value={proof.observedAt} />

        {proof.failureReason && <p className="why warn">{proof.failureReason}</p>}

        {/* The one sentence that explains what this proof is and is not. */}
        <p className="lnote">
          This proof records what was sent and what came back — not the text of either. The commitment can only be
          opened with the nonce returned when the route was compared, which this server did not keep.
        </p>
      </div>
    </div>
  );
}
