import React from 'react';

// ---------------------------------------------------------------------------
// T67C — the B20 Control Card.
//
// The whole panel is built to make one thing impossible: reading a grade off
// it. There is no badge, no colour scale, no percentage and no word like
// "safe". Every row is either a value that was read at a stated block, or a
// stated reason there is no value. A user who wants to know whether a token is
// safe is told what its controls PERMIT and what state they were in, and is
// left to decide — which is the only honest thing this data supports.
//
// Presentational only: it takes a wire object structurally and renders it.
// Classes come from console.css; inventing new ones ships unstyled text.
// ---------------------------------------------------------------------------

export type B20FieldStatusLikeV1 =
  | 'exact_chain_read'
  | 'unavailable'
  | 'not_enumerable'
  | 'unsupported_by_variant'
  | 'planned_not_active'
  | 'conflicting_evidence';

export interface B20FieldLikeV1 {
  key: string;
  label: string;
  status: B20FieldStatusLikeV1;
  value: string | null;
  reason: string | null;
  evidenceHash: string | null;
}

export interface B20StatementLikeV1 {
  key: string;
  statement: string;
  observedState: 'constrained' | 'unconstrained' | 'unknown';
  evidenceHash: string | null;
}

export interface B20CardLikeV1 {
  tokenAddress: string;
  displayName: string | null;
  displaySymbol: string | null;
  variant: 'asset' | 'stablecoin' | null;
  detectionOutcome: string;
  blockNumber: string | null;
  blockHash: string | null;
  observedAt: string;
  fields: readonly B20FieldLikeV1[];
  statements: readonly B20StatementLikeV1[];
  unavailable: readonly string[];
  boundaries: readonly string[];
}

/** What each row status is called on screen. Every one of these is a sentence
 * about the READ, never about the token's character. */
export const B20_FIELD_STATUS_LABEL_V1: Record<B20FieldStatusLikeV1, string> = {
  exact_chain_read: 'read at this block',
  unavailable: 'not available',
  not_enumerable: 'this interface cannot list it',
  unsupported_by_variant: 'not part of this variant',
  planned_not_active: 'planned, not active',
  conflicting_evidence: 'sources disagree',
};

/** What an observed control state is called. `unknown` is a real answer here,
 * not a placeholder. */
export const B20_STATE_LABEL_V1: Record<B20StatementLikeV1['observedState'], string> = {
  constrained: 'currently constrained',
  unconstrained: 'currently open',
  unknown: 'not observed',
};

export function shortB20HashV1(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '—';
}

/** The message for an address that is not a B20 token. It says what was
 * checked and what this card does NOT do, so nobody reads silence as a pass. */
export const B20_NOT_B20_COPY_V1 = [
  'This address was not verified as a B20 token.',
  'Ordinary ERC-20 analysis is not part of this card.',
] as const;

export const B20_DETECTION_COPY_V1: Record<string, string> = {
  b20: 'Confirmed by the B20 factory.',
  b20_uninitialised: 'The factory recognises this token, but it has not finished being created.',
  not_b20: B20_NOT_B20_COPY_V1[0],
  unavailable_at_block: 'B20 was not active at the block that was read, so nothing could be checked.',
  rpc_failure: 'The endpoint did not answer. This says nothing about the token.',
  invalid_address: 'That is not a 20-byte address.',
  unsupported_chain: 'This card reads Base mainnet only.',
};

export function B20ControlCardPanel({ card }: { card: B20CardLikeV1 }): React.ReactElement {
  const isB20 = card.detectionOutcome === 'b20' || card.detectionOutcome === 'b20_uninitialised';
  return (
    <section className="panel">
      <h3>B20 Control</h3>
      <div className="kv">
        <span>Token</span>
        <span className="mono">{card.tokenAddress}</span>
      </div>
      {isB20 && (
        <div className="kv">
          <span>Name</span>
          <span>
            {card.displayName ?? '—'}
            {card.displaySymbol ? ` (${card.displaySymbol})` : ''}
            {card.variant ? ` · ${card.variant}` : ''}
          </span>
        </div>
      )}
      <p className="note">{B20_DETECTION_COPY_V1[card.detectionOutcome] ?? 'Nothing was determined.'}</p>
      {!isB20 && <p className="note">{B20_NOT_B20_COPY_V1[1]}</p>}

      {/* The block is not a footnote: every value above and below is a claim
          about this block and no other. */}
      <div className="kv">
        <span>Observed at block</span>
        <span className="mono">{card.blockNumber ?? 'not reached'}</span>
      </div>
      <div className="kv">
        <span>Block hash</span>
        <span className="mono">{shortB20HashV1(card.blockHash)}</span>
      </div>
    </section>
  );
}

export function B20ControlsPanel({ card }: { card: B20CardLikeV1 }): React.ReactElement | null {
  if (card.statements.length === 0) return null;
  return (
    <section className="panel">
      <h3>What these controls permit</h3>
      {card.statements.map((statement) => (
        <div className="kv" key={statement.key}>
          <span>{statement.statement}</span>
          <span>{B20_STATE_LABEL_V1[statement.observedState]}</span>
        </div>
      ))}
      <p className="note">
        Who holds these powers is not readable: B20 answers whether a given address holds a role and
        offers no way to list role holders.
      </p>
    </section>
  );
}

export function B20FieldsPanel({ card }: { card: B20CardLikeV1 }): React.ReactElement | null {
  if (card.fields.length === 0) return null;
  return (
    <section className="panel">
      <h3>Observed state</h3>
      {card.fields.map((field) => (
        <div className="kv" key={field.key}>
          <span>{field.label}</span>
          {/* A row without a value shows its reason in the value position, so
              a gap can never be mistaken for a zero. */}
          <span className={field.status === 'exact_chain_read' ? 'mono' : undefined}>
            {field.status === 'exact_chain_read' ? field.value : (field.reason ?? B20_FIELD_STATUS_LABEL_V1[field.status])}
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * T67E §1 — the contextual B20 Control Card, as one block.
 *
 * The panels above existed and were exported and tested from the day T67C
 * landed; nothing ever imported them, so a user comparing a B20 token saw no
 * controls at all. This composes them for the Route and Review screens and adds
 * the two states a mounted card has to survive: the read has not finished, and
 * the read was refused.
 *
 * `cached` is surfaced rather than hidden. A snapshot from four blocks ago is a
 * different claim from a current one, and the whole card is scoped to a block.
 */
export interface B20ControlSectionPropsV1 {
  card: B20CardLikeV1 | null;
  /** True while the inspection is in flight. */
  loading?: boolean;
  /** Why there is no card. Rendered verbatim; never replaced by a guess. */
  unavailableReason?: string | null;
  /** The answer came from a stored snapshot inside its TTL. */
  cached?: boolean;
  /** Full detail (fields + evidence). Review shows it; Route stays compact. */
  detailed?: boolean;
}

export function B20ControlSection({
  card,
  loading = false,
  unavailableReason = null,
  cached = false,
  detailed = false,
}: B20ControlSectionPropsV1): React.ReactElement | null {
  if (loading) {
    return (
      <section className="panel">
        <h3>B20 Control</h3>
        <p className="note">Reading this token’s controls on Base…</p>
      </section>
    );
  }
  if (!card) {
    // No card and no stated reason means nothing was attempted — rendering an
    // empty B20 panel there would imply a check that never ran.
    if (!unavailableReason) return null;
    return (
      <section className="panel">
        <h3>B20 Control</h3>
        <p className="note">{unavailableReason}</p>
      </section>
    );
  }
  return (
    <>
      <B20ControlCardPanel card={card} />
      {cached && (
        <p className="note">
          Read from a stored snapshot at block {card.blockNumber ?? 'unknown'}, not re-read just now.
        </p>
      )}
      <B20ControlsPanel card={card} />
      {detailed && <B20FieldsPanel card={card} />}
      {detailed && <B20EvidencePanel card={card} />}
    </>
  );
}

export function B20EvidencePanel({ card }: { card: B20CardLikeV1 }): React.ReactElement {
  const read = card.fields.filter((field) => field.status === 'exact_chain_read');
  return (
    <section className="panel">
      <h3>Evidence</h3>
      {read.map((field) => (
        <div className="kv" key={field.key}>
          <span>{field.label}</span>
          <span className="mono">{shortB20HashV1(field.evidenceHash)}</span>
        </div>
      ))}
      {card.unavailable.length > 0 && (
        <>
          <h3>Not available</h3>
          {card.unavailable.map((line) => (
            <p className="note" key={line}>
              {line}
            </p>
          ))}
        </>
      )}
      <h3>What this card does not cover</h3>
      {card.boundaries.map((line) => (
        <p className="note" key={line}>
          {line}
        </p>
      ))}
    </section>
  );
}
