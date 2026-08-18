import React from 'react';
import {
  B20_STANDING_GROUPS_V1,
  B20_STANDING_GROUP_COPY_V1,
  type B20ExitStandingKindV1,
  type B20StandingGroupV1,
} from '@mioagent/opportunity-rail/exitStanding';
import type { B20ConsumerCardV1 } from '@mioagent/opportunity-rail/consumerCard';
import {
  B20_FUNDAMENTAL_DIMENSION_LABEL_V1,
  B20_FUNDAMENTAL_STANDING_COPY_V1,
  B20_PROJECT_FILTERS_V1,
  B20_PROJECT_FILTER_COPY_V1,
  B20_FUNDAMENTAL_STALE_COPY_V1,
  b20FundamentalHighlightsV1,
  type B20FundamentalProfileV1,
  type B20ProjectFilterV1,
} from '@mioagent/opportunity-rail/fundamentals';
import {
  CONSOLE_NO_ANALYSIS_COPY_V1,
  type ConsoleIndexStatusV1,
  type ConsoleOperationalLabelV1,
  type ConsolePipelineStateV1,
} from './navigation';
import { factValueClassV1 } from './opportunityCardView';
import { B20ConsolePanel, type B20ConsolePanelModelV1 } from './B20ConsolePanel';
import { B20LaunchContextCard, type B20LaunchContextModelV1 } from './B20LaunchContextCard';
import { B20PublicContextCard, type B20PublicContextModelV1 } from './B20PublicContextCard';
import { discoverCardDomIdV1 } from './discoverFocus';

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

/**
 * The verdict filter, which is the one a person actually wants.
 *
 * `rejected` covered four different things at once — 4,067 launches under one
 * sentence — so a filter on the measurement STATE could not express "show me
 * the tokens somebody bought and Miorail could not sell". This one can, and the
 * server applies it, because the section a card belongs to is spread thinly
 * enough through the feed that no client could group its way to it.
 */
export const OPPORTUNITY_STANDING_FILTERS_V1 = ['all', ...B20_STANDING_GROUPS_V1] as const;
export type OpportunityStandingFilterV1 = (typeof OPPORTUNITY_STANDING_FILTERS_V1)[number];

/** Re-exported so a host wires the project filter without reaching past
 * `@mioagent/ui` into the domain package. */
export type { B20FundamentalProfileV1, B20ProjectFilterV1 };

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
  /** Exact append-only observation references. Null only before measurement. */
  observationId: `0x${string}` | null;
  evidenceHash: `0x${string}` | null;
  observationBlockNumber: string | null;
  /** One line: what was found. From the shared copy table, not written here. */
  headline: string;
  /** The sentence under it. */
  detail: string;
  /** Which of the eight measured conclusions this card reached. */
  standingKind: B20ExitStandingKindV1;
  /**
   * FALSE when the card is describing a limit of Miorail's own measurement
   * rather than anything about the token. Thirty per cent of the live feed is
   * in that position, and a screen that mixes those cards in with findings is
   * publishing Miorail's failures under a token's name.
   */
  aboutToken: boolean;
  /** The section this card is filed under. Decided by the shared projection. */
  standingGroup: B20StandingGroupV1;
  /** What the conclusion rests on and what it does not claim. */
  standingDetail: string;
  /**
   * The same evidence, said to a reader who has never heard of a reason code.
   *
   * This is what the collapsed card renders. Everything beside it on this
   * object — `state`, `standingKind`, `standingDetail`, the hashes, the blocks —
   * is untouched and still feeds the technical evidence section, the API and
   * MCP. Nothing was simplified away; the engineering vocabulary moved down a
   * level.
   */
  consumer: B20ConsumerCardV1;
  /**
   * Whether a project proved a link to this token.
   *
   * Null when this server does not run the layer — which is NOT the same as
   * "nobody claimed it", and the card renders nothing at all rather than
   * asserting the second from the first.
   */
  project: B20FundamentalProfileV1 | null;
  /** Round-trip cost, already formatted. Null means it was not measured. */
  costLabel: string | null;
  /**
   * Exit capacity as a BOUND, never a point. "at least 4,000 · fails by 8,000"
   * — there is no field here for an interpolated exact figure, which is the
   * strongest form that prohibition can take.
   */
  capacityLabel: string | null;
  /** The profile the measurement used, so the numbers mean something. Null
   * when there is no measurement — the row is then not rendered at all. */
  profileLabel: string | null;
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
  /** Which side of the allowlisted route search actually priced. This remains
   * useful when the headline round trip/capacity could not be measured. */
  routeLabel: string | null;
  routeNote: string | null;
  routeTone: 'ok' | 'warn';
  /** Which venues the reading actually asked. "Not recorded" on every
   * observation written before the field existed — which is not the same
   * statement as "none", and the note says so. */
  venueLabel: string | null;
  venueNote: string | null;
  /** Who bought out of the pool in the launch's own window, in words. Null
   * when nobody measured that window — never rendered as "0 buyers", which
   * would be a claim nobody made. */
  buyersLabel: string | null;
  buyersNote: string | null;
  /** Dimensions this product did not measure and will not imply. */
  notMeasured: readonly string[];
}

export interface B20CopilotAnswerViewV1 {
  schemaVersion: 'b20-copilot-answer/v1';
  /** Which answer the reader is looking at. `verified_narration` is a model's
   * rephrasing of the SAME evidence, kept only after every number in it was
   * found in that evidence; anything else falls back to the first. */
  answerSource: 'deterministic_evidence' | 'verified_narration';
  questionKind:
    | 'summary'
    | 'why_rejected'
    | 'unusual'
    | 'missing_evidence'
    | 'explain_hook'
    | 'exit_capacity'
    | 'compare_previous';
  subject: { tokenAddress: string; symbol: string; name: string };
  observation: {
    observationId: string;
    evidenceHash: string;
    blockNumber: string;
    measuredAt: string;
    freshness: 'fresh' | 'stale';
  } | null;
  answer: string;
  facts: readonly { label: string; value: string; tone: 'neutral' | 'positive' | 'warning' }[];
  missingEvidence: readonly string[];
  caveats: readonly string[];
  routeHandoff: { label: 'Open in Routes'; goal: string } | null;
}

export interface B20CopilotPanelModelV1 {
  /** The card whose latest request owns the mutation state. */
  tokenAddress: string | null;
  loading: boolean;
  answer: B20CopilotAnswerViewV1 | null;
  error: string | null;
  onAsk: (input: {
    tokenAddress: string;
    observationId: `0x${string}` | null;
    evidenceHash: `0x${string}` | null;
    question: string;
  }) => void;
  onOpenRoutes: (goal: string) => void;
}

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
   * What the INDEX has covered, as distinct from what has been measured.
   *
   * Optional while a caller rolls forward; absent renders exactly as before.
   * It never carries a percentage or a derived figure — the two counts it
   * shows are scoped differently and do not divide into each other.
   */
  indexStatus?: ConsoleIndexStatusV1 | null;
  /**
   * False when the pipeline's own sentence describes a backlog rather than a
   * fault, and so belongs under Index details instead of above the feed.
   * Absent behaves as true, which is the old behaviour.
   */
  pipelineNoticeLeads?: boolean;
  /**
   * False when the pipeline has something to say instead of a list. The empty
   * state below is then never drawn — that is the whole point of §9.2.
   */
  feedRenderable: boolean;
  cards: readonly OpportunityCardViewV1[];
  filter: OpportunityFilterV1;
  /** The verdict section being asked for. Optional while a caller rolls
   * forward; absent behaves as `all`. */
  standingFilter?: OpportunityStandingFilterV1;
  /** Project context, which is a different axis from what was measured. Also
   * a SERVER filter: a verified claim is rare enough that grouping one page
   * would be the same as not having the filter. */
  projectFilter?: B20ProjectFilterV1;
  onProjectFilterChange?: (filter: B20ProjectFilterV1) => void;
  freshOnly: boolean;
  loading: boolean;
  onFilterChange: (filter: OpportunityFilterV1) => void;
  onStandingFilterChange?: (filter: OpportunityStandingFilterV1) => void;
  onFreshOnlyChange: (freshOnly: boolean) => void;
  /**
   * Hands the token to the surface that owns wallet-bound checks.
   *
   * This is the SERVER's action — "Check against my wallet", "Try another
   * profile", "Refresh measurement" — and all three of them need the exit
   * profile and the wallet, which live on Portfolio. It is never the card's
   * default click: reading a measurement must not require leaving Discover.
   */
  onOpenToken: (tokenAddress: string) => void;
  /**
   * Opens this token's measurement, on this surface.
   *
   * Optional while a host rolls forward; absent renders no such control rather
   * than a button that leads nowhere. Wiring it is what makes a card's primary
   * action Discover-local — the wallet-bound handoff stays a separate, labelled
   * control beside it.
   */
  onOpenMeasurement?: (tokenAddress: string) => void;
  /** Optional while older deployments roll forward. It is read-only. */
  copilot?: B20CopilotPanelModelV1;
  /**
   * Stage 07 — the global console, rendered above the feed.
   *
   * Optional for the same reason the per-card copilot is: a surface that has
   * not wired it yet renders the feed exactly as before rather than an empty
   * panel. The per-card copilot is unchanged by its presence — that one stays
   * pinned to one observation, and this one cannot pin anything.
   */
  console?: B20ConsolePanelModelV1;
  /**
   * Stage 09 — Launch Context, opened per card.
   *
   * On request rather than on render: the honest content for almost every
   * launch is "an address sent a transaction", and a feed that fetched it for
   * every card would spend a query per launch to show a sentence nobody asked
   * for.
   */
  launchContext?: B20LaunchContextModelV1;
  /**
   * Unverified public context, opened per card.
   *
   * Optional, and absent renders no such control at all rather than one
   * that leads to a refusal: this surface is flag-gated and needs a search
   * provider, and a button that cannot work is worse than no button.
   */
  publicContext?: B20PublicContextModelV1;
  /**
   * One token, opened by name from the URL.
   *
   * Optional while a host rolls forward; absent renders the feed exactly as
   * before. The card may come from the page the feed already loaded or from a
   * detail read by address — this screen does not care which, and deliberately
   * cannot tell, so a token outside the current page is not a second code path.
   */
  focus?: B20DiscoverFocusModelV1;
  onRefresh?: () => void;
}

/**
 * The focused measurement, as this screen meets it.
 *
 * `card` is null while it loads and null when the address is not in the feed at
 * all. Those two are different sentences on screen, which is why `loading` and
 * `notFound` are separate fields rather than inferred from a null card.
 */
export interface B20DiscoverFocusModelV1 {
  /** Lowercased address, or null when nothing is focused. */
  tokenAddress: string | null;
  loading: boolean;
  card: OpportunityCardViewV1 | null;
  /** True when the feed knows no canonical launch at this address. */
  notFound: boolean;
  /** A transport failure, which is not the same as "no such launch". */
  error: string | null;
  /** Returns to the whole feed. The host drops the query parameter. */
  onClear: () => void;
}

const B20_COPILOT_PROMPTS_V1 = [
  'Why was this rejected?',
  'What is unusual here?',
  'What evidence is missing?',
  'Explain this hook.',
  'Can I get out with a 100 USDC position?',
  'What changed since the previous measurement?',
] as const;

// ---------------------------------------------------------------------------
// Project context.
//
// A different axis from everything else on the card: the rest of it is what
// Miorail MEASURED about a market, and this is what a project PUBLISHED about
// itself and Miorail then checked. Rendered as its own block for that reason —
// folding the two together would let a verified project read as a measured exit
// or the reverse.
//
// Three renderings, and the quiet one is the common case. Almost every launch
// on this chain is unclaimed, so an unverified project gets ONE muted line
// rather than a section of empty rows: a column of unknowns invites a reader to
// wonder what would fill it in, when the honest answer is that nothing may be
// attached to this token at all.
// ---------------------------------------------------------------------------
function ProjectContext({ project }: { project: B20FundamentalProfileV1 | null }) {
  // Null means this server does not run the layer. That is not a statement
  // about the token, so the card says nothing rather than saying "unverified".
  if (project === null) return null;

  if (!project.identityVerified) {
    // The verdict stays on the card; the paragraph explaining it moves under a
    // disclosure. Unverified is the ORDINARY case — most launches are never
    // claimed — so this text appeared in full on nearly every card in the feed,
    // which is how a careful sentence turns into noise a reader learns to skip.
    // The verified branch below already worked this way; this is the same
    // treatment for the case that occurs far more often.
    return (
      <details className="card-evidence project-unverified">
        <summary>Project context — {B20_FUNDAMENTAL_STANDING_COPY_V1.unverified.label}</summary>
        <div className="card-evidence-body">
          <p className="lnote">{project.detail}</p>
        </div>
      </details>
    );
  }

  const highlights = b20FundamentalHighlightsV1(project);
  // Past its window. The findings are unchanged and still say what they said;
  // this is the marker that stops a day-old product probe reading as a current
  // fact — the same treatment, and the same word, the exit rails use.
  const stale = project.freshness === 'stale';
  return (
    <section className="project-context" aria-label="Project context">
      <div className="project-head">
        <span className="project-name">{project.projectDomain}</span>
        <span className="pill cr-status" data-tone="measured">
          {B20_FUNDAMENTAL_STANDING_COPY_V1[project.standing].label}
        </span>
        {stale && <span className="pill n rail-fact-mark">stale</span>}
      </div>
      {stale && <p className="note warn">{B20_FUNDAMENTAL_STALE_COPY_V1}</p>}
      {highlights.length > 0 && (
        <dl className="cr-facts">
          {highlights.map((finding) => (
            <div key={finding.dimension}>
              <dt>{B20_FUNDAMENTAL_DIMENSION_LABEL_V1[finding.dimension]}</dt>
              <dd>
                <strong>{finding.label}</strong>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <details className="card-evidence">
        <summary>View evidence</summary>
        <div className="card-evidence-body">
          {/* What the whole block does and does not claim, before any of it. */}
          <p className="lnote">{project.detail}</p>
          {project.findings.map((finding) => (
            <div key={finding.dimension} className="project-evidence-row">
              <div className="kv">
                <span className="k">{B20_FUNDAMENTAL_DIMENSION_LABEL_V1[finding.dimension]}</span>
                <span className="v">{finding.label}</span>
              </div>
              {/* Provenance and time on every state. A state with neither is an
                  assertion, and this layer publishes no assertions. */}
              <p className="lnote mono">
                {finding.provenance.replaceAll('_', ' ')}
                {finding.observedAt ? ` · ${finding.observedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}
                {finding.reference ? ` · ${finding.reference}` : ''}
              </p>
              <p className="lnote">{finding.note}</p>
            </div>
          ))}
          {project.missing.length > 0 && (
            // Named rather than omitted. A dimension that is simply absent reads
            // as "nothing to report"; a named one reads as "nobody established
            // this", which is what it means.
            <p className="lnote">
              Not established:{' '}
              {project.missing.map((dimension) => B20_FUNDAMENTAL_DIMENSION_LABEL_V1[dimension].toLowerCase()).join(', ')}.
            </p>
          )}
          <p className="lnote">
            Project context comes from a file this project serves on its own domain, and from probes of the
            things that file declared. It is not a review, not a rating and not a statement about price.
          </p>
        </div>
      </details>
    </section>
  );
}

function OpportunityCard({
  card,
  onOpen,
  onOpenMeasurement,
  copilot,
  launchContext,
  publicContext,
  measurementOpen,
}: {
  card: OpportunityCardViewV1;
  onOpen: (tokenAddress: string) => void;
  /** Absent inside the focused view, where the card IS the measurement. */
  onOpenMeasurement?: (tokenAddress: string) => void;
  copilot?: B20CopilotPanelModelV1;
  launchContext?: B20LaunchContextModelV1;
  publicContext?: B20PublicContextModelV1;
  /** Opens "What was measured" on render. Set only by the focused view, which
   * exists because a reader asked for this token's measurement by name. */
  measurementOpen?: boolean;
}) {
  const [askOpen, setAskOpen] = React.useState(false);
  const [question, setQuestion] = React.useState('');
  // A failed route read is still a stored observation with a profile. The
  // values decide whether the metric block has something to show; profile
  // presence does not. This is the production shape of route_search_degraded.
  const measurementMissing = card.costLabel === null && card.capacityLabel === null;
  const measurementState =
    card.state === 'unmeasured'
      ? 'Not measured'
      : card.state === 'candidate'
        ? 'Queued'
        : 'No complete measurement';
  const ownsCopilotState = copilot?.tokenAddress === card.tokenAddress;
  const answer = ownsCopilotState ? copilot?.answer ?? null : null;
  const ask = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !copilot) return;
    copilot.onAsk({
      tokenAddress: card.tokenAddress,
      observationId: card.observationId,
      evidenceHash: card.evidenceHash,
      question: trimmed,
    });
  };
  return (
    // No amber rail for a card with no numbers. It used to mark every card
    // whose round trip and capacity were null, which after the verdict split is
    // mostly "nobody has bought this yet" — an absent market, not a fault. The
    // section a card sits in now carries that meaning honestly.
    // The id is the scroll target for a deep link. It is derived from the token
    // address by the same helper the link builder uses, so a URL and the element
    // it points at cannot drift apart.
    <article className="cardrow" id={discoverCardDomIdV1(card.tokenAddress)}>
      <div className="cr-top">
        <span className="cr-name">
          {card.symbol} <span className="sub">{card.name}</span>
        </span>
        {/* What was MEASURED, not what state the measurement profile reached.
            This used to be the raw `rejected` pill, which is a verdict about a
            reference threshold and read on screen as a verdict about the token.
            The state itself is still here — in Technical evidence below. */}
        <span className="pill cr-status" data-tone={card.consumer.tone}>
          {card.consumer.status}
        </span>
      </div>

      {/* The conclusion first, in the card's largest voice, and the evidence
          under a control. The old card opened with two metric tiles reading
          "not measured" on four cards in five, so the first thing a reader met
          was an absence — and the sentence that explained it was two sizes
          smaller, below the fold of the eye. */}
      <p className="cr-verdict">{card.consumer.headline}</p>
      <p className="lnote">{card.consumer.body}</p>

      {/* Two to four facts, above any control. This is what a reader came for
          and it used to be behind "What was measured": the round-trip number
          that makes a card different from its neighbour was one click away
          while a reason code nobody can read was in the body copy. */}
      {card.consumer.facts.length > 0 && (
        <dl className="cr-facts">
          {card.consumer.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>
                <strong className={factValueClassV1(fact.value)}>{fact.value}</strong>
                {fact.note ? <span className="cr-fact-note"> · {fact.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Never behind the fold. A pre-entry, quote-alignment or transfer-policy
          sentence is a warning about what the numbers below are worth, and a
          warning a reader has to open something to see is not a warning. */}
      {card.notices.map((notice) => (
        <p key={notice} className="note warn">
          {notice}
        </p>
      ))}

      <ProjectContext project={card.project} />


      <details className="card-evidence" open={measurementOpen === true}>
        <summary>What was measured</summary>
        <div className="card-evidence-body">
          {measurementMissing ? (
            <div className="measurement-missing">
              <span>Round trip + exit capacity</span>
              <strong className="mono">{measurementState}</strong>
            </div>
          ) : (
            <div className="cr-nums">
              <div>
                <span className="cr-k">Round trip</span>
                {/* Null renders the words, never a zero. */}
                <span className={'cr-v mono' + (card.costLabel ? '' : ' warn')}>
                  {card.costLabel ?? 'not measured'}
                </span>
              </div>
              <div>
                <span className="cr-k">Exit capacity</span>
                <span className={'cr-v mono' + (card.capacityLabel ? '' : ' warn')}>
                  {card.capacityLabel ?? 'not measured'}
                </span>
              </div>
            </div>
          )}

          {/* The typed measurement sentence. It stays under the fold because it
              speaks the evidence vocabulary — `no_exit_route` and its copy —
              while the verdict above says what that amounted to. */}
          <p className="lnote">{card.detail}</p>

          {/* Hidden rather than printed as "not measured". A row whose whole job
              is to name the profile a measurement used says nothing when there
              was no measurement, and repeating the words is how one unmeasured
              card came to say "not measured" five times. */}
          {card.profileLabel && (
            <div className="kv">
              <span className="k">Measured against</span>
              <span className="v mono">{card.profileLabel}</span>
            </div>
          )}
          <div className="kv">
            <span className="k">{card.timeLabel}</span>
            <span className="v mono">{card.timeValue}</span>
          </div>
          <div className="kv">
            <span className="k">Variant</span>
            <span className="v">{card.variantLabel}</span>
          </div>

          {/* The one part of a B20 venue that can be verified by inspection: v4
              spells a hook's permissions in the low bits of its own address, and
              a B20 token's own code cannot be read at all. Shown as permission,
              not behaviour — the sentence says so explicitly. */}
          {card.hookLabel && (
            <div className="kv">
              <span className="k">Pool hook</span>
              <span className="v">{card.hookLabel}</span>
            </div>
          )}
          {card.hookNote && <p className="lnote">{card.hookNote}</p>}

          {card.routeLabel && (
            <div className="kv">
              <span className="k">Route liquidity</span>
              <span className={`v ${card.routeTone}`}>{card.routeLabel}</span>
            </div>
          )}
          {card.routeNote && <p className="lnote">{card.routeNote}</p>}

          {/* Which venues were ASKED. Distinct from route coverage, which only
              says whether the candidates a search generated answered — and
              1,581 stored observations claim complete coverage over a search
              that never included the venue where B20 tokens trade. */}
          {card.venueLabel && (
            <div className="kv">
              <span className="k">Venues searched</span>
              <span className={card.venueNote ? 'v warn' : 'v'}>{card.venueLabel}</span>
            </div>
          )}
          {card.venueNote && <p className="lnote">{card.venueNote}</p>}

          {/* Concentration of launch-window buying. The exit-first reading: if
              one wallet took everything that left the pool, an exit depends on
              that wallet not selling first. */}
          {card.buyersLabel && (
            <div className="kv">
              <span className="k">Bought at launch</span>
              <span className="v">{card.buyersLabel}</span>
            </div>
          )}
          {card.buyersNote && <p className="lnote">{card.buyersNote}</p>}

          {/* Only beside a real measurement. The list exists to bound what a
              measurement CLAIMS; on a card where nothing was measured it is
              seven more negations under a sentence that already said nothing
              was checked. */}
          {card.notMeasured.length > 0 && card.profileLabel && (
            <p className="lnote">Not measured: {card.notMeasured.join(', ')}.</p>
          )}
        </div>
      </details>

      {/* Technical evidence.

          Everything the engineering vocabulary owns, in one place a power user
          can open and nobody else has to read: the measurement state, the typed
          reason, the profile, the observation block and the append-only
          references. None of it was removed — it stopped being the first thing
          on the card. A reader who wants `round_trip_above_tolerance` finds it
          here, spelled exactly as the API and MCP return it. */}
      <details className="card-evidence">
        <summary>Technical evidence</summary>
        <div className="card-evidence-body">
          <div className="kv">
            <span className="k">Measurement state</span>
            <span className="v mono">{card.state}</span>
          </div>
          <div className="kv">
            <span className="k">Standing</span>
            <span className="v mono">{card.standingKind}</span>
          </div>
          {/* The typed sentence the measurement itself produced, reason code and
              all. Above, the card says what that amounted to. */}
          <p className="lnote">{card.standingDetail}</p>
          {card.observationBlockNumber && (
            <div className="kv">
              <span className="k">Observation block</span>
              <span className="v mono">{card.observationBlockNumber}</span>
            </div>
          )}
          {card.observationId && (
            <div className="kv">
              <span className="k">Observation</span>
              <span className="v mono">{card.observationId}</span>
            </div>
          )}
          {card.evidenceHash && (
            <div className="kv">
              <span className="k">Evidence hash</span>
              <span className="v mono">{card.evidenceHash}</span>
            </div>
          )}
          <p className="lnote">
            These are the exact values the API and MCP return for this card. The words above are a
            reading of them, not a replacement.
          </p>
        </div>
      </details>

      {/* Beside the evidence and closed by default. Whoever launched a token
          is a different question from what its exit measured, and answering it
          unasked would put an address on every card. */}
      {launchContext && <B20LaunchContextCard tokenAddress={card.tokenAddress} model={launchContext} />}

      {/* Below the verified project block and below the launch context, so
          a reader meets what Miorail PROVED before what it merely found. */}
      {publicContext && (
        <B20PublicContextCard tokenAddress={card.tokenAddress} symbol={card.symbol} model={publicContext} />
      )}

      {/* T69-C.1 §2/§3 — the reason is always shown, and the button appears
          only when there is something a user could usefully do. A fresh
          rejection that holds for every wallet gets the sentence and no
          control: offering one would suggest their wallet might be exempt from
          a fact about the token. */}
      <p className="note">{card.actionReason}</p>
      <div className="card-actions">
        {/* First, and on every card. Opening what Miorail measured about this
            token is the one thing a reader can always do here, it needs no
            wallet, and it stays on Discover. The card's only control used to be
            the server's action, which hands the token to Portfolio — so a
            reader who wanted to read a measurement was sent to a different
            product area to do it. */}
        {onOpenMeasurement && (
          <button type="button" className="btn sec" onClick={() => onOpenMeasurement(card.tokenAddress)}>
            View measurement
          </button>
        )}
        {card.actionLabel && (
          <button type="button" className="btn sec" onClick={() => onOpen(card.tokenAddress)}>
            {card.actionLabel}
          </button>
        )}
        {copilot && (
          <button
            type="button"
            className={`btn sec ask-card${askOpen ? ' on' : ''}`}
            aria-expanded={askOpen}
            onClick={() => setAskOpen((open) => !open)}
          >
            Ask Miorail
          </button>
        )}
      </div>

      {askOpen && copilot && (
        <section className="b20-copilot" aria-label={`Ask Miorail about ${card.symbol}`}>
          <div className="b20-copilot-head">
            <div>
              <span className="eyebrow">Evidence lens</span>
              <strong>Ask this B20 card</strong>
            </div>
            <span className="mono observation-stamp">
              {card.observationBlockNumber ? `block ${card.observationBlockNumber}` : 'measurement pending'}
            </span>
          </div>
          <p className="lnote">
            Answers are rebuilt from this exact stored observation. Miorail explains evidence and unknowns; Routes
            owns fresh quotes and execution.
          </p>
          <div className="b20-prompt-chips" aria-label="Example questions">
            {B20_COPILOT_PROMPTS_V1.map((prompt) => (
              <button key={prompt} type="button" onClick={() => { setQuestion(prompt); ask(prompt); }}>
                {prompt}
              </button>
            ))}
          </div>
          <form
            className="b20-ask-form"
            onSubmit={(event) => {
              event.preventDefault();
              ask(question);
            }}
          >
            <label htmlFor={`b20-ask-${card.tokenAddress}`}>Ask about this observation</label>
            <div>
              <input
                id={`b20-ask-${card.tokenAddress}`}
                value={question}
                maxLength={500}
                placeholder="What evidence is missing?"
                onChange={(event) => setQuestion(event.currentTarget.value)}
              />
              <button type="submit" className="btn" disabled={!question.trim() || (ownsCopilotState && copilot.loading)}>
                {ownsCopilotState && copilot.loading ? 'Reading…' : 'Ask'}
              </button>
            </div>
          </form>

          {ownsCopilotState && copilot.error && <p className="note warn">{copilot.error}</p>}
          {answer && (
            <div className="b20-answer" aria-live="polite">
              <p>{answer.answer}</p>
              {/* Which answer this is. A rephrasing by a model is kept only
                  after every number in it was found in the evidence below, and
                  a reader is entitled to know which of the two they are
                  reading rather than inferring it from the prose. */}
              <p className="lnote">
                {answer.answerSource === 'verified_narration'
                  ? 'Rephrased from the evidence below. Every figure in it was checked against that evidence.'
                  : 'Built directly from the stored observation.'}
              </p>
              {answer.facts.length > 0 && (
                <dl className="b20-answer-facts">
                  {answer.facts.map((fact) => (
                    <div key={`${fact.label}:${fact.value}`}>
                      <dt>{fact.label}</dt>
                      <dd className={fact.tone === 'warning' ? 'warn' : fact.tone === 'positive' ? 'ok' : ''}>
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {answer.missingEvidence.length > 0 && (
                <details className="b20-answer-unknowns">
                  <summary>{answer.missingEvidence.length} evidence gaps</summary>
                  <ul>
                    {answer.missingEvidence.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </details>
              )}
              {answer.routeHandoff && (
                <button
                  type="button"
                  className="btn sec"
                  onClick={() => copilot.onOpenRoutes(answer.routeHandoff!.goal)}
                >
                  {answer.routeHandoff.label}
                </button>
              )}
              <details className="b20-answer-caveats">
                <summary>Evidence boundaries</summary>
                <ul>{answer.caveats.map((item) => <li key={item}>{item}</li>)}</ul>
              </details>
            </div>
          )}
        </section>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The focused measurement.
//
// Rendered above the feed rather than by scrolling to a card, because the card
// a reader asked for is frequently not on the page: the feed shows 25 of ~26,000
// launches in the window, and the rails rank over 1,000. Loading the detail by
// address is the only way "View measurement" can mean the same thing for a token
// on page one and a token on page forty.
//
// It shows the SAME card component as the feed. A second rendering of a
// measurement is a second place for it to disagree with itself.
// ---------------------------------------------------------------------------
function FocusedMeasurement({
  focus,
  onOpenToken,
  copilot,
  launchContext,
  publicContext,
}: {
  focus: B20DiscoverFocusModelV1;
  onOpenToken: (tokenAddress: string) => void;
  copilot?: B20CopilotPanelModelV1;
  launchContext?: B20LaunchContextModelV1;
  publicContext?: B20PublicContextModelV1;
}) {
  const anchor = React.useRef<HTMLDivElement | null>(null);
  const token = focus.tokenAddress;
  React.useEffect(() => {
    if (!token || !anchor.current) return;
    // Only when the browser can honour it. `scrollIntoView` is missing in the
    // static-render path the tests use and in older Base App webviews.
    anchor.current.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [token]);

  if (!token) return null;

  return (
    <div className="panel" ref={anchor} aria-label="Focused measurement">
      <div className="ph">
        <h3>Measurement</h3>
        <span className="rt">
          <button type="button" className="btn sec" onClick={focus.onClear}>
            Back to all
          </button>
        </span>
      </div>
      <div className="pb">
        {focus.loading ? (
          <p className="empty">Reading this token’s measurement…</p>
        ) : focus.error ? (
          <p className="note warn">{focus.error}</p>
        ) : focus.notFound ? (
          // Not "this is not a B20 token". Discover knows what it ingested, and
          // an address it has no canonical launch for is a gap in this index.
          <p className="empty">
            Miorail has no canonical B20 launch at <span className="mono">{token}</span> in this index, so there
            is no measurement to open.
          </p>
        ) : focus.card ? (
          <div className="cardrows">
            <OpportunityCard
              card={focus.card}
              onOpen={onOpenToken}
              copilot={copilot}
              launchContext={launchContext}
              publicContext={publicContext}
              measurementOpen
            />
          </div>
        ) : (
          <p className="empty">Reading this token’s measurement…</p>
        )}
      </div>
    </div>
  );
}

/**
 * The feed, split into the sections a reader can act on.
 *
 * Order comes from `B20_STANDING_GROUPS_V1`, so the screen cannot invent its
 * own — and an empty section is dropped rather than drawn with a zero, because
 * "0 tokens were bought and could not be sold" is a claim about this page, not
 * about the feed.
 */
export function opportunitySectionsV1(
  cards: readonly OpportunityCardViewV1[],
): { group: B20StandingGroupV1; cards: OpportunityCardViewV1[] }[] {
  return B20_STANDING_GROUPS_V1.map((group) => ({
    group,
    cards: cards.filter((card) => card.standingGroup === group),
  })).filter((section) => section.cards.length > 0);
}

export function OpportunitiesScreen(model: OpportunitiesScreenModelV1) {
  const filters = OPPORTUNITY_FILTERS_V1;
  const standingFilter = model.standingFilter ?? 'all';
  const sections = opportunitySectionsV1(model.cards);
  // A backlog sentence may move under Index details only while there are cards
  // to read instead. With nothing in the feed it is the ONLY thing explaining
  // an empty screen, and an explanation a reader has to expand is not one.
  const noticeLeads = model.pipelineNoticeLeads !== false || model.cards.length === 0;
  return (
    <>
      {(model.pipelineNotice || model.pipelineLabel || model.indexStatus) && (
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
            {/* What the INDEX is doing, first.
                The measurement backlog used to lead here — "22,265 launches
                have been found and are waiting for Exit-First measurement" —
                which is true and reads as "Miorail found 22k tokens and did
                almost nothing with them". What actually happened is that the
                index reached B20 genesis. The backlog keeps its exact number,
                one level down. */}
            {model.indexStatus && (
              <div className="index-status">
                <p className="index-headline">{model.indexStatus.headline}</p>
                {model.indexStatus.tracked && <p className="lnote">{model.indexStatus.tracked}</p>}
                {model.indexStatus.cursor && <p className="lnote mono">{model.indexStatus.cursor}</p>}
              </div>
            )}
            {/* §9 — where the cursor actually is. An operator and a user read
                the same two numbers, and neither has to infer them from the
                length of the list below. Suppressed only when the index status
                above already says the cursor is caught up, which is the one
                case where both blocks are the same number. */}
            {model.pipelineProgress && !model.indexStatus?.cursor && (
              <p className="lnote mono">{model.pipelineProgress}</p>
            )}
            {/* The pipeline's sentence, verbatim from the shared copy table.
                This is the line that stops "nothing has run" being read as
                "nothing is out there" — so it still leads for every state that
                names a fault. `measurement_pending` is the exception: its
                message is a backlog, and it moves into Index details. */}
            {model.pipelineNotice && noticeLeads && <p className="note">{model.pipelineNotice}</p>}
            {model.indexStatus && (
              <details className="discover-guide">
                <summary>Index details</summary>
                <dl className="cr-facts">
                  {model.indexStatus.details.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>
                        <strong className="mono">{row.value}</strong>
                      </dd>
                    </div>
                  ))}
                </dl>
                {/* The backlog sentence, verbatim, where it is an answer rather
                    than a headline. */}
                {model.pipelineNotice && !noticeLeads && <p className="lnote">{model.pipelineNotice}</p>}
                <p className="lnote">{model.indexStatus.detailNote}</p>
              </details>
            )}
            {model.onRefresh && (
              <button type="button" className="btn sec" onClick={model.onRefresh}>
                Check again
              </button>
            )}
          </div>
        </div>
      )}

      {/* One token, opened by name. Above everything else: a reader who clicked
          "View measurement" asked for this card and nothing else on the page. */}
      {model.focus?.tokenAddress && (
        <FocusedMeasurement
          focus={model.focus}
          onOpenToken={model.onOpenToken}
          copilot={model.copilot}
          launchContext={model.launchContext}
          publicContext={model.publicContext}
        />
      )}

      {/* Above the feed, because the question a reader arrives with is about
          the whole list rather than about the first card in it. Rendered even
          when the feed is not: "how many were measured" is answerable while
          the pipeline is catching up, and the counts are the honest answer to
          a screen that has nothing to list yet. */}
      {model.console && <B20ConsolePanel {...model.console} />}

      {model.feedRenderable && (
        <div className="panel">
          <div className="ph">
            {/* What the panel IS. "Opportunities" is a promise this surface
                does not make — every card here is a measurement, and four in
                five of them are a measurement that found no way out. */}
            <h3>Discover B20</h3>
            <span className="rt">
              <span className="sub">{model.cards.length} shown</span>
            </span>
          </div>
          <div className="pb tight">
            <p className="discover-scope">
              Every card is built around a B20 token found through Miorail’s pinned B20 factory feed on Base.
              This is B20 route intelligence, not a general token scanner.
            </p>
            {/* The verdict filter leads, because it is the question people
                arrive with. The measurement state stays available underneath —
                it is the vocabulary the evidence and the x402 seller speak, and
                removing it would cost a real capability. */}
            {model.onStandingFilterChange && (
              <div className="filter-row">
                <span className="filter-row-k">What was found</span>
                <nav className="crumb" aria-label="Filter by what the measurement found">
                  {OPPORTUNITY_STANDING_FILTERS_V1.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      className={`btn sec${standingFilter === filter ? ' on' : ''}`}
                      aria-pressed={standingFilter === filter}
                      onClick={() => model.onStandingFilterChange?.(filter)}
                    >
                      {filter === 'all' ? 'Everything' : B20_STANDING_GROUP_COPY_V1[filter].chip}
                    </button>
                  ))}
                </nav>
              </div>
            )}
            {/* A different axis from what was measured, so its own row. The
                third option is where almost every launch on this chain belongs,
                and it is worded as a state rather than as a shortfall. */}
            {model.onProjectFilterChange && (
              <div className="filter-row">
                <span className="filter-row-k">Project context</span>
                <nav className="crumb" aria-label="Filter by project context">
                  {B20_PROJECT_FILTERS_V1.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      className={`btn sec${(model.projectFilter ?? 'all') === filter ? ' on' : ''}`}
                      aria-pressed={(model.projectFilter ?? 'all') === filter}
                      onClick={() => model.onProjectFilterChange?.(filter)}
                    >
                      {B20_PROJECT_FILTER_COPY_V1[filter]}
                    </button>
                  ))}
                </nav>
              </div>
            )}
            {/* Freshness is a question a reader has; `provisional` and
                `rejected` are not. So the freshness toggle stays out here beside
                what was found, and the measurement states move behind Advanced —
                still one click away, still the vocabulary the evidence, the API
                and the x402 seller speak. Removing them would cost a real
                capability; leading with them cost every reader. */}
            <div className="filter-row">
              <span className="filter-row-k">Evidence</span>
              <nav className="crumb" aria-label="Filter by evidence freshness">
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
              sections.map((section) => {
                const copy = B20_STANDING_GROUP_COPY_V1[section.group];
                return (
                  <section className="feed-section" key={section.group} aria-label={copy.label}>
                    <div className="feed-section-head">
                      <h4>{copy.label}</h4>
                      <span className="pill n">{section.cards.length}</span>
                    </div>
                    {/* The section says what the whole group does and does not
                        claim, once, rather than every card repeating it. The
                        Miorail-limit section is the one that has to exist:
                        thirty per cent of the live feed describes a measurement
                        that did not complete, and those cards were sitting in
                        the same list as findings. */}
                    <p className="lnote">{copy.note}</p>
                    <div className="cardrows">
                      {section.cards.map((card) => (
                        <OpportunityCard
                          key={card.tokenAddress}
                          card={card}
                          onOpen={model.onOpenToken}
                          onOpenMeasurement={model.onOpenMeasurement}
                          copilot={model.copilot}
                          launchContext={model.launchContext}
                          publicContext={model.publicContext}
                        />
                      ))}
                    </div>
                  </section>
                );
              })
            )}
          </div>

          {/* Reference material, below the findings.
              These two used to sit between the filters and the first card, so
              the last thing a reader passed before meeting a token was a
              glossary and a list of measurement states. Neither is an answer to
              a question anybody arrives with; both are things a reader reaches
              for once a card has raised one. Nothing was removed — the
              measurement-state filter is the vocabulary the evidence, the API
              and the x402 seller speak, and it still works exactly as before. */}
          <div className="pb tight">
            <details className="discover-guide">
              <summary>Advanced · measurement state</summary>
              <div className="filter-row">
                <span className="filter-row-k">Measurement state</span>
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
                </nav>
              </div>
              <p className="lnote">
                The measurement profile’s own states. `provisional` is the strongest thing background
                measurement says and is still not a confirmation; `rejected` means a reference check did
                not pass, which is a threshold this product set rather than a fault found in a token.
              </p>
            </details>
            <details className="discover-guide">
              <summary>How to read a B20 card</summary>
              <dl>
                <div>
                  <dt>Round trip</dt>
                  <dd>Immediate entry and exit cost at the fixed reference size.</dd>
                </div>
                <div>
                  <dt>Exit capacity</dt>
                  <dd>Largest exit size actually tested within the 3% reference.</dd>
                </div>
                <div>
                  <dt>Route liquidity</dt>
                  <dd>Which side of the allowlisted route search could be priced.</dd>
                </div>
                <div>
                  <dt>Bought at launch</dt>
                  <dd>Buyer concentration after the complete 10,000-block launch window.</dd>
                </div>
              </dl>
              <p>
                A card measures exit conditions. It does not predict returns, recommend a token, or produce a
                combined rating. “Past freshness window” means historical evidence, not a current quote.
              </p>
              {/* The one thing a reader has to understand about the sections. */}
              <p>
                Cards are grouped by what the measurement found. The last group is different from the others: it
                holds cards where Miorail’s own reading did not complete — a venue it did not find, a call that did
                not answer — and none of those is a statement about the token.
              </p>
            </details>
          </div>
        </div>
      )}

      {!model.feedRenderable && !model.pipelineNotice && (
        <div className="panel">
          <div className="ph">
            <h3>Discover B20</h3>
          </div>
          <div className="pb">
            <p className="empty">{CONSOLE_NO_ANALYSIS_COPY_V1}</p>
          </div>
        </div>
      )}
    </>
  );
}
