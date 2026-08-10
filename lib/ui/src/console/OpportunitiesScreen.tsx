import React from 'react';
import {
  CONSOLE_NO_ANALYSIS_COPY_V1,
  type ConsoleOperationalLabelV1,
  type ConsolePipelineStateV1,
} from './navigation';

void React;

// ---------------------------------------------------------------------------
// T70 §1/§5 — the product's home screen.
//
// Two things this surface must never do, both of which it would do by default:
//
//   * render an empty card list as "No opportunities" when the pipeline has
//     never run. Seven different failures produce an empty array and only one
//     of them is "the chain was quiet";
//
//   * render a missing number as a number. An unmeasured round-trip cost shown
//     as 0.00% is a lie with a decimal point in it.
//
// Everything it displays comes from the server's card projection. It computes
// no verdict, holds no clearance and opens no wallet: choosing a token here
// hands the address to the surface that already owns that flow.
// ---------------------------------------------------------------------------

/** T69-C §12 — the filters, in order. `fresh` is a modifier on the others. */
export const OPPORTUNITY_FILTERS_V1 = ['all', 'provisional', 'rejected', 'unmeasured'] as const;
export type OpportunityFilterV1 = (typeof OPPORTUNITY_FILTERS_V1)[number];

export const OPPORTUNITY_FILTER_LABEL_V1: Readonly<Record<OpportunityFilterV1, string>> = {
  all: 'All',
  provisional: 'Provisional',
  rejected: 'Rejected',
  unmeasured: 'Unmeasured',
};

export type OpportunityStateV1 = 'candidate' | 'provisional' | 'rejected' | 'unmeasured';

/**
 * What a card shows.
 *
 * Deliberately a view model rather than the wire type: every numeric field is
 * already a formatted string or null, so this component cannot accidentally
 * turn a null into a zero on its way to a screen. The mapping happens once, in
 * the surface that owns the API.
 */
export interface OpportunityCardViewV1 {
  tokenAddress: string;
  symbol: string;
  name: string;
  /** "asset" / "stablecoin" — the launch variant, not a judgement. */
  variantLabel: string;
  /** T69-C.1 §1 — "Launched" with a real age, or "Discovered by Miorail" with
   * the block. The projection decides which; the card never labels a detection
   * time as a launch time. */
  timeLabel: string;
  timeValue: string;
  state: OpportunityStateV1;
  /** One line: what was found. From the shared copy table, not written here. */
  headline: string;
  /** The sentence under it. */
  detail: string;
  /** Round-trip cost, already formatted. Null means it was not measured. */
  costLabel: string | null;
  /**
   * Exit capacity as a BOUND, never a point. "at least 4,000 · fails by 8,000"
   * — there is no field here for an interpolated exact figure, which is the
   * strongest form that prohibition can take.
   */
  capacityLabel: string | null;
  /** The profile the measurement used, so the numbers mean something. */
  profileLabel: string;
  fresh: boolean;
  /** The button's words, or null when this card offers no action. */
  actionLabel: string | null;
  /** Always present: why this action, or why none. §3 depends on it. */
  actionReason: string;
  /** Pre-entry, quote-alignment and transfer-policy sentences, in order. */
  notices: readonly string[];
  /** What the pool's Uniswap v4 hook is ALLOWED to do — "standard" or not, and
   * the permissions its address spells. Null when the venue has no hook or
   * none was recorded. Never a behaviour: a hook permitted to take a fee may
   * take none, and only the measured round trip says what an exit cost. */
  hookLabel: string | null;
  /** The sentence under it, when the permissions are worth stating. */
  hookNote: string | null;
  /** Who bought out of the pool in the launch's own window, in words. Null
   * when nobody measured that window — never rendered as "0 buyers", which
   * would be a claim nobody made. */
  buyersLabel: string | null;
  buyersNote: string | null;
  /** Dimensions this product did not measure and will not imply. */
  notMeasured: readonly string[];
}

const STATE_PILL_V1: Readonly<Record<OpportunityStateV1, { tone: 'g' | 'a' | 'n' | 'br'; label: string }>> = {
  // `br` and not `g`: a provisional pass is the strongest thing background
  // measurement can say, and it is still not a confirmation. Green would read
  // as one.
  provisional: { tone: 'br', label: 'provisional' },
  rejected: { tone: 'a', label: 'rejected' },
  unmeasured: { tone: 'n', label: 'not measured' },
  candidate: { tone: 'n', label: 'queued' },
};

export interface OpportunitiesScreenModelV1 {
  /** The pipeline's own sentence. Rendered ABOVE the list, always, when set. */
  pipelineNotice: string | null;
  pipelineState: ConsolePipelineStateV1 | null;
  /** T73-LIVE §9 — the operational state in one word. Rendered even when the
   * pipeline is healthy, because "Caught up above an empty list" and "empty
   * list" are different statements and only the first one is honest. */
  pipelineLabel?: ConsoleOperationalLabelV1 | null;
  /** `Block X of Y · N behind`, or null when either block is unknown. */
  pipelineProgress?: string | null;
  /**
   * False when the pipeline has something to say instead of a list. The empty
   * state below is then never drawn — that is the whole point of §9.2.
   */
  feedRenderable: boolean;
  cards: readonly OpportunityCardViewV1[];
  filter: OpportunityFilterV1;
  freshOnly: boolean;
  loading: boolean;
  onFilterChange: (filter: OpportunityFilterV1) => void;
  onFreshOnlyChange: (freshOnly: boolean) => void;
  /** Hands the token to the surface that owns wallet-bound checks. */
  onOpenToken: (tokenAddress: string) => void;
  onRefresh?: () => void;
}

function OpportunityCard({
  card,
  onOpen,
}: {
  card: OpportunityCardViewV1;
  onOpen: (tokenAddress: string) => void;
}) {
  const pill = STATE_PILL_V1[card.state];
  return (
    <article className="cardrow">
      <div className="cr-top">
        <span className="cr-name">
          {card.symbol} <span className="sub">{card.name}</span>
        </span>
        <span className={`pill ${pill.tone}`}>{pill.label}</span>
      </div>

      <div className="cr-nums">
        <div>
          <span className="cr-k">Round trip</span>
          {/* Null renders the words, never a zero. */}
          <span className={`cr-v mono${card.costLabel ? '' : ' warn'}`}>{card.costLabel ?? 'not measured'}</span>
        </div>
        <div>
          <span className="cr-k">Exit capacity</span>
          <span className={`cr-v mono${card.capacityLabel ? '' : ' warn'}`}>
            {card.capacityLabel ?? 'not measured'}
          </span>
        </div>
      </div>

      <p className="cr-why">{card.headline}</p>
      <p className="lnote">{card.detail}</p>

      {card.notices.map((notice) => (
        <p key={notice} className="note warn">
          {notice}
        </p>
      ))}

      <div className="kv">
        <span className="k">Measured against</span>
        <span className="v mono">{card.profileLabel}</span>
      </div>
      <div className="kv">
        <span className="k">{card.timeLabel}</span>
        <span className="v mono">{card.timeValue}</span>
      </div>
      <div className="kv">
        <span className="k">Variant</span>
        <span className="v">{card.variantLabel}</span>
      </div>

      {/* The one part of a B20 venue that can be verified by inspection: v4
          spells a hook's permissions in the low bits of its own address, and a
          B20 token's own code cannot be read at all. Shown as permission, not
          behaviour — the sentence says so explicitly. */}
      {card.hookLabel && (
        <div className="kv">
          <span className="k">Pool hook</span>
          <span className="v">{card.hookLabel}</span>
        </div>
      )}
      {card.hookNote && <p className="lnote">{card.hookNote}</p>}

      {/* Concentration of launch-window buying. The exit-first reading: if one
          wallet took everything that left the pool, an exit depends on that
          wallet not selling first. */}
      {card.buyersLabel && (
        <div className="kv">
          <span className="k">Bought at launch</span>
          <span className="v">{card.buyersLabel}</span>
        </div>
      )}
      {card.buyersNote && <p className="lnote">{card.buyersNote}</p>}

      {card.notMeasured.length > 0 && (
        <p className="lnote">Not measured: {card.notMeasured.join(', ')}.</p>
      )}

      {/* T69-C.1 §2/§3 — the reason is always shown, and the button appears
          only when there is something a user could usefully do. A fresh
          rejection that holds for every wallet gets the sentence and no
          control: offering one would suggest their wallet might be exempt from
          a fact about the token. */}
      <p className="note">{card.actionReason}</p>
      {card.actionLabel && (
        <button type="button" className="btn sec" onClick={() => onOpen(card.tokenAddress)}>
          {card.actionLabel}
        </button>
      )}
    </article>
  );
}

export function OpportunitiesScreen(model: OpportunitiesScreenModelV1) {
  const filters = OPPORTUNITY_FILTERS_V1;
  return (
    <>
      {(model.pipelineNotice || model.pipelineLabel) && (
        <div className="panel">
          <div className="ph">
            <h3>Discover</h3>
            {/* No pill when there is no state. "unknown" told the user nothing
                the sentence below does not say better, and read as a fault in
                the token rather than in the connection. */}
            {(model.pipelineLabel || model.pipelineState) && (
              <span className="rt">
                <span className={model.pipelineLabel === 'Caught up' ? 'pill' : 'pill n'}>
                  {model.pipelineLabel ?? model.pipelineState?.replaceAll('_', ' ')}
                </span>
              </span>
            )}
          </div>
          <div className="pb tight">
            {/* §9 — where the cursor actually is. An operator and a user read
                the same two numbers, and neither has to infer them from the
                length of the list below. */}
            {model.pipelineProgress && <p className="lnote mono">{model.pipelineProgress}</p>}
            {/* The pipeline's sentence, verbatim from the shared copy table.
                This is the line that stops "nothing has run" being read as
                "nothing is out there". */}
            {model.pipelineNotice && <p className="note">{model.pipelineNotice}</p>}
            {model.onRefresh && (
              <button type="button" className="btn sec" onClick={model.onRefresh}>
                Check again
              </button>
            )}
          </div>
        </div>
      )}

      {model.feedRenderable && (
        <div className="panel">
          <div className="ph">
            <h3>Opportunities</h3>
            <span className="rt">
              <span className="sub">{model.cards.length} shown</span>
            </span>
          </div>
          <div className="pb tight">
            <nav className="crumb" aria-label="Filter opportunities">
              {filters.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`btn sec${model.filter === filter ? ' on' : ''}`}
                  aria-pressed={model.filter === filter}
                  onClick={() => model.onFilterChange(filter)}
                >
                  {OPPORTUNITY_FILTER_LABEL_V1[filter]}
                </button>
              ))}
              <button
                type="button"
                className={`btn sec${model.freshOnly ? ' on' : ''}`}
                aria-pressed={model.freshOnly}
                onClick={() => model.onFreshOnlyChange(!model.freshOnly)}
              >
                Fresh only
              </button>
            </nav>
          </div>
          <div className="pb">
            {model.loading ? (
              <p className="empty">Reading measured launches…</p>
            ) : model.cards.length === 0 ? (
              // Reachable only when the pipeline is healthy: `feedRenderable`
              // is false in every other state, so this sentence cannot be shown
              // about a product that was never switched on.
              <p className="empty">
                No measured B20 opportunities match this filter. Both workers are current.
              </p>
            ) : (
              <div className="cardrows">
                {model.cards.map((card) => (
                  <OpportunityCard key={card.tokenAddress} card={card} onOpen={model.onOpenToken} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {!model.feedRenderable && !model.pipelineNotice && (
        <div className="panel">
          <div className="ph">
            <h3>Opportunities</h3>
          </div>
          <div className="pb">
            <p className="empty">{CONSOLE_NO_ANALYSIS_COPY_V1}</p>
          </div>
        </div>
      )}
    </>
  );
}
