// ---------------------------------------------------------------------------
// T70 §8 — one section vocabulary, shared by the web console and Base App.
//
// Before this file the two surfaces each held their own tab list. They had
// already drifted: web said "B20", the miniapp said nothing at all, and the
// order was decided independently in three places. A user who learns the
// product on a phone and opens it on a laptop should not have to re-learn where
// things are, so the sections, their order and their words live here and both
// shells read them.
//
// The other half of this file is what an EMPTY Opportunities feed is allowed to
// mean. Discover has seven ways of being empty and only one of them is "the
// chain was quiet" — see `consoleHomeSectionV1`.
// ---------------------------------------------------------------------------

/** Every place a user can be. `settings` is deliberately last: it is where you
 * go to change something, not a surface you work in. */
export const CONSOLE_SECTIONS_V1 = ['opportunities', 'portfolio', 'routes', 'activity', 'extensions', 'settings'] as const;

export type ConsoleSectionV1 = (typeof CONSOLE_SECTIONS_V1)[number];

export interface ConsoleSectionDefinitionV1 {
  readonly id: ConsoleSectionV1;
  /** The word on the web console's header. */
  readonly label: string;
  /**
   * The word in Base App's four-up bar. Different only where the full label
   * does not survive a 390px screen split four ways — and still drawn from this
   * table rather than typed into the miniapp, which is what §8 is protecting.
   */
  readonly compactLabel: string;
  /** The web path. Static: no address, no goal, no wallet state (§8). */
  readonly path: string;
  /** One sentence. Used by the command palette and by a disabled entry. */
  readonly blurb: string;
}

export const CONSOLE_SECTION_TABLE_V1: Readonly<Record<ConsoleSectionV1, ConsoleSectionDefinitionV1>> = {
  opportunities: {
    id: 'opportunities',
    // "Opportunities" describes the shape of the list, not what is in it. This
    // is the B20 launch feed, and Discover is what a user looking for new
    // tokens would scan for.
    //
    // "Discover B20" rather than "Discover", because the feed is not a general
    // token scanner: every card is built around a token found through the
    // pinned B20 factory. The card inside the page has said so for a while, and
    // a reader who only sees the nav should not have to open it to find out
    // which universe they are discovering.
    label: 'Discover B20',
    compactLabel: 'Discover B20',
    path: '/opportunities',
    blurb: 'Measured B20 launches, and what getting back out would cost.',
  },
  portfolio: {
    id: 'portfolio',
    // Named for what the surface DOES, not for the generic category it sits
    // in. Almost everything here is B20 — holdings, controls, exit checks —
    // and wallet balances are context for them rather than the subject. The
    // compact bar has said "B20" since it was built, with a comment noting
    // that is what the tab actually contains; the full label just never
    // followed, so the two disagreed on every screen wider than 390px.
    label: 'B20',
    compactLabel: 'B20',
    path: '/portfolio',
    blurb: 'The B20 tokens you hold, what their controls have done, and your wallet balances.',
  },
  extensions: {
    id: 'extensions',
    // This surface is the reviewed extension layer around Base MCP: plugin
    // catalogue, live tools and a thread scoped to those capabilities. "AI"
    // described the input method, not the product boundary.
    label: 'Base MCP Extensions',
    compactLabel: 'MCP Extensions',
    path: '/extensions',
    blurb: 'Reviewed Base MCP plugins, live tools, and a thread scoped to those capabilities.',
  },
  routes: {
    id: 'routes',
    // Routes produces a measured Route Card; Base MCP Extensions exposes
    // reviewed third-party capabilities. Their names keep that boundary clear.
    label: 'Routes AI',
    compactLabel: 'Routes AI',
    path: '/routes',
    blurb: 'State a goal and compare the ways to reach it.',
  },
  activity: {
    id: 'activity',
    // Was "Proofs", which promised the one thing that only exists after a
    // signature. Every route run in production sits at `ready` and every proof
    // table is empty, so the tab was named for its rarest row. This surface is
    // a journal of runs and paid intelligence that BECOMES a proof journal —
    // the same gap Portfolio/Discover had, and the same fix.
    label: 'Activity',
    compactLabel: 'Activity',
    path: '/plan/history',
    blurb: 'Route runs, what each one reached, paid intelligence, and proofs once a route is signed.',
  },
  settings: {
    id: 'settings',
    label: 'Settings',
    compactLabel: 'Settings',
    path: '/settings',
    blurb: 'Budget & payments, route adapters, providers and network status.',
  },
};

/**
 * The primary navigation, in order. Opportunities first because it is the only
 * surface that answers "what should I look at?" — Routes answers "how do I do
 * this thing I already decided on", which is a later question.
 *
 * Three, not four. Activity moved to the drawer beside Extensions: a tab bar
 * of three working surfaces is more honest than four where one is a viewer for
 * records this deployment has never produced, and the three that remain get
 * ~130px each on a 390px screen instead of ~90px.
 */
export const CONSOLE_PRIMARY_SECTIONS_V1 = ['opportunities', 'portfolio', 'routes'] as const;

/** T70 §3 — the mobile drawer is exactly these six and nothing else. */
// Activity and Extensions sit in the drawer rather than the tab bar. Neither
// is where work starts; both are places you go to look something up.
export const CONSOLE_DRAWER_SECTIONS_V1 = [...CONSOLE_PRIMARY_SECTIONS_V1, 'activity', 'extensions', 'settings'] as const;

export function consoleSectionLabelV1(section: ConsoleSectionV1): string {
  return CONSOLE_SECTION_TABLE_V1[section].label;
}

export function consoleSectionPathV1(section: ConsoleSectionV1): string {
  return CONSOLE_SECTION_TABLE_V1[section].path;
}

/**
 * Which section a path belongs to.
 *
 * Prefix-matched so `/portfolio/0xabc…` still highlights Portfolio, and the
 * legacy paths keep resolving — a bookmark from before this file existed is not
 * a reason to show no active tab.
 */
export function consoleSectionFromPathV1(path: string): ConsoleSectionV1 | null {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  const LEGACY_V1: Record<string, ConsoleSectionV1> = {
    '/': 'routes',
    '/b20': 'portfolio',
  };
  if (LEGACY_V1[clean]) return LEGACY_V1[clean];
  for (const section of CONSOLE_SECTIONS_V1) {
    const base = CONSOLE_SECTION_TABLE_V1[section].path;
    if (clean === base || clean.startsWith(`${base}/`)) return section;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface ConsoleNavItemV1 {
  id: ConsoleSectionV1;
  label: string;
  compactLabel: string;
  path: string;
  active: boolean;
  /** False when the surface is mounted but cannot be used right now. */
  available: boolean;
  /**
   * T70 §6 — present exactly when `available` is false. A greyed-out control
   * with no words is a dead end: the user cannot tell "not yet" from "broken"
   * from "you did something wrong", and low contrast is not an explanation.
   */
  unavailableReason: string | null;
}

export interface ConsoleNavInputV1 {
  /**
   * The sections this surface actually mounts. T70 §4: a tab whose handler is
   * not wired is not rendered at all — a button that navigates nowhere is worse
   * than an absent one, because it looks like a broken product rather than an
   * unfinished one.
   */
  mounted: readonly ConsoleSectionV1[];
  active: ConsoleSectionV1 | null;
  /** Sections that are mounted but temporarily unusable, with the reason. */
  unavailable?: Partial<Record<ConsoleSectionV1, string>>;
}

export function consoleNavModelV1(input: ConsoleNavInputV1): ConsoleNavItemV1[] {
  const mounted = new Set(input.mounted);
  return CONSOLE_SECTIONS_V1.filter((section) => mounted.has(section)).map((section) => {
    const definition = CONSOLE_SECTION_TABLE_V1[section];
    const reason = input.unavailable?.[section] ?? null;
    return {
      id: section,
      label: definition.label,
      compactLabel: definition.compactLabel,
      path: definition.path,
      // An unusable section is never the active one: navigating to a surface
      // that cannot answer is how a user ends up staring at a blank column.
      active: input.active === section && reason === null,
      available: reason === null,
      unavailableReason: reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Where the product opens
// ---------------------------------------------------------------------------

/**
 * Mirrors `B20_PIPELINE_STATES_V1` in lib/opportunity-rail.
 *
 * Mirrored rather than imported: lib/ui is compiled by the miniapp at ES2017,
 * and opportunity-rail's barrel reaches modules with BigInt literals, which are
 * a compile error at that target. `navigation.test.ts` reads the other file
 * from disk and fails if the two lists ever diverge, so this is a copy that
 * cannot rot silently.
 */
export const CONSOLE_PIPELINE_STATES_V1 = [
  'configuration_required',
  'ingestion_not_started',
  'ingestion_catching_up',
  'measurement_pending',
  'healthy',
  'degraded',
  'worker_stale',
  'decoder_mismatch',
  'storage_unavailable',
] as const;

export type ConsolePipelineStateV1 = (typeof CONSOLE_PIPELINE_STATES_V1)[number];

// ---------------------------------------------------------------------------
// T73-LIVE §9 — the operational state, in one word.
//
// The rule this exists to enforce: never infer "the chain is quiet" from an
// empty list. An empty feed with a healthy pipeline and an empty feed with a
// worker that died three hours ago looked identical, and a user had no way to
// tell which they were looking at.
//
// Mirrors `b20OperationalLabelV1` in @mioagent/opportunity-rail for the same
// reason the state list above is mirrored — this package compiles into the
// miniapp at a target where that package's dependencies do not belong.
// `navigation.test.ts` reads the other file from disk and fails on drift.
// ---------------------------------------------------------------------------

export type ConsoleOperationalLabelV1 =
  | 'Caught up'
  | 'Measuring'
  | 'Catching up'
  | 'Worker stale'
  | 'Unavailable';

export function consoleOperationalLabelV1(
  state: ConsolePipelineStateV1 | null,
): ConsoleOperationalLabelV1 | null {
  // Null is not "unavailable": the feed request itself has not answered, and
  // claiming a pipeline state from no data is the guess this whole surface is
  // supposed to stop making.
  if (state === null) return null;
  switch (state) {
    case 'storage_unavailable':
    case 'configuration_required':
    case 'decoder_mismatch':
      return 'Unavailable';
    case 'worker_stale':
    case 'ingestion_not_started':
      return 'Worker stale';
    case 'ingestion_catching_up':
    case 'degraded':
      return 'Catching up';
    // Its own word. `measurement_pending` used to share 'Caught up' with
    // `healthy`, so the panel read "Caught up" directly above "440 launches
    // have been found and are waiting for Exit-First measurement" — two true
    // statements about two different stages, printed as a contradiction.
    // Ingestion being current says nothing about whether anything was measured.
    case 'measurement_pending':
      return 'Measuring';
    case 'healthy':
      return 'Caught up';
  }
}

/** The cursor line, when both blocks are known. Plain numbers, no endpoint. */
export function consolePipelineProgressV1(input: {
  ingestionCursorBlock: string | null;
  confirmedHead: string | null;
  blocksBehind: number | null;
}): string | null {
  if (!input.ingestionCursorBlock || !input.confirmedHead) return null;
  const behind = input.blocksBehind === null ? '' : ` · ${input.blocksBehind.toLocaleString('en-US')} behind`;
  return `Block ${Number(input.ingestionCursorBlock).toLocaleString('en-US')} of ${Number(
    input.confirmedHead,
  ).toLocaleString('en-US')}${behind}`;
}

// ---------------------------------------------------------------------------
// Index coverage is not measurement coverage.
//
// After the historical backfill the top of Discover read:
//
//   22,265 launches have been found and are waiting for Exit-First measurement.
//
// True, and the wrong first impression: it reads as "Miorail found 22k tokens
// and did almost nothing with them" when what actually happened is that the
// index reached B20 genesis. Two different stages, and the one a reader should
// meet first is the one that is finished.
//
// So the panel leads with what the INDEX is doing and keeps the measurement
// backlog available underneath — a real number, never a percentage, and never
// arithmetic between the two counts. `launchesAwaitingMeasurement` is scoped to
// the measurement worker's own age window while `canonicalLaunchCount` is every
// canonical launch ever stored, so subtracting one from the other would invent
// a "measured" figure nothing counted.
// ---------------------------------------------------------------------------

export interface ConsoleIndexFactsV1 {
  canonicalLaunchCount: number;
  launchesAwaitingMeasurement: number;
  observationCount: number;
  ingestionCursorBlock: string | null;
  confirmedHead: string | null;
}

export interface ConsoleIndexStatusV1 {
  /** What the INDEX is doing. Never a measurement count. */
  headline: string;
  /** The tracked corpus, or null when nothing has been indexed yet. */
  tracked: string | null;
  /** Where the ingestion cursor is, in words. */
  cursor: string | null;
  /** The expandable. Label/value pairs, each an exact stored count. */
  details: readonly { label: string; value: string }[];
  /** What those counts do and do not mean, in one sentence. */
  detailNote: string;
}

const INDEX_HEADLINE_V1: Readonly<Record<ConsolePipelineStateV1, string>> = {
  // Ingestion is current in both. `measurement_pending` is only reached after
  // the staleness and catching-up checks have already passed, so saying the
  // index is synced here is exactly true.
  healthy: 'B20 index synced',
  measurement_pending: 'B20 index synced',
  // The worker runs and the cursor moves; some reads came back incomplete.
  degraded: 'B20 index synced · some reads incomplete',
  ingestion_catching_up: 'B20 index catching up',
  worker_stale: 'B20 index not advancing',
  ingestion_not_started: 'B20 index not started',
  configuration_required: 'B20 index not configured',
  decoder_mismatch: 'B20 index stopped',
  storage_unavailable: 'B20 index unavailable',
};

const INDEX_LIVE_STATE_V1: Readonly<Record<ConsolePipelineStateV1, string>> = {
  healthy: 'caught up',
  measurement_pending: 'caught up',
  degraded: 'reading, some reads incomplete',
  ingestion_catching_up: 'catching up',
  worker_stale: 'not advancing',
  ingestion_not_started: 'never run',
  configuration_required: 'not configured',
  decoder_mismatch: 'stopped',
  storage_unavailable: 'unavailable',
};

/**
 * The one state whose pipeline message describes a BACKLOG rather than a fault.
 *
 * Every other message names something wrong or something to do, and those still
 * lead the panel. This one is replaced by the index status above it, and its
 * number reappears in the details as `Awaiting first measurement`.
 */
export function consolePipelineNoticeLeadsV1(state: ConsolePipelineStateV1 | null): boolean {
  return state !== 'measurement_pending';
}

export function consoleIndexStatusV1(input: {
  state: ConsolePipelineStateV1 | null;
  facts: ConsoleIndexFactsV1 | null;
}): ConsoleIndexStatusV1 | null {
  // No state means the feed request itself did not answer. Claiming an index
  // status from no data is the guess this surface exists to stop making.
  if (input.state === null || input.facts === null) return null;
  const facts = input.facts;
  const count = (value: number) => value.toLocaleString('en-US');

  const tracked =
    facts.canonicalLaunchCount > 0
      ? `${count(facts.canonicalLaunchCount)} launch${
          facts.canonicalLaunchCount === 1 ? '' : 'es'
        } tracked from the pinned B20 factory feed`
      : null;

  const cursor =
    facts.ingestionCursorBlock === null
      ? null
      : consolePipelineNoticeLeadsV1(input.state) || facts.confirmedHead === null
        ? // Behind, stopped or unknown: the honest line is both blocks, which
          // `consolePipelineProgressV1` already renders above.
          null
        : `Caught up to Base block ${Number(facts.ingestionCursorBlock).toLocaleString('en-US')}`;

  return {
    headline: INDEX_HEADLINE_V1[input.state],
    tracked,
    cursor,
    details: [
      { label: 'Canonical launches', value: count(facts.canonicalLaunchCount) },
      { label: 'Stored measurements', value: count(facts.observationCount) },
      { label: 'Awaiting first measurement', value: count(facts.launchesAwaitingMeasurement) },
      { label: 'Live index', value: INDEX_LIVE_STATE_V1[input.state] },
    ],
    // The sentence that stops these four numbers being read as a coverage
    // percentage. A stored measurement is an observation, and one launch can
    // carry several over time, so the counts do not divide into each other.
    detailNote:
      'Indexing and measuring are separate stages. Stored measurements counts observations rather than launches, and launches awaiting a first measurement is counted over the measurement worker’s own window — so these figures are exact counts and not shares of one another.',
  };
}

export interface ConsoleHomeInputV1 {
  /** Null when the feed endpoint itself could not be reached. */
  pipeline: { state: ConsolePipelineStateV1; message: string } | null;
  /** How many measured opportunities the feed returned. */
  observationCount: number;
  /** Portfolio needs a wallet; Routes does not. */
  walletConnected: boolean;
}

export interface ConsoleHomeV1 {
  section: ConsoleSectionV1;
  /**
   * Why the user is here rather than on Opportunities, or what Opportunities is
   * currently doing. Null only when the feed is healthy AND has something in
   * it — the one case that needs no explanation.
   */
  notice: string | null;
  /**
   * Whether the Opportunities surface may draw a card list. False means the
   * pipeline has something to say first, and an empty list underneath it would
   * read as "nothing is out there" (§1, §9.2).
   */
  feedRenderable: boolean;
}

/** States where Discover cannot produce a feed at all and the user belongs
 * somewhere that works. */
const DISCOVER_UNAVAILABLE_V1: ReadonlySet<ConsolePipelineStateV1> = new Set([
  'configuration_required',
  'storage_unavailable',
  'decoder_mismatch',
]);

export const CONSOLE_DISCOVER_UNREACHABLE_COPY_V1 =
  'Discover could not be reached on this server, so there is no launch feed. This says nothing about what is launching.';

/**
 * Why the feed request failed, in the user's terms.
 *
 * The generic sentence above was the only thing this surface said, and it made
 * four unrelated problems look identical: a server without the routes deployed,
 * an expired session, unreachable storage, and a frontend newer than the API.
 * Exactly one of those is fixed by pressing "Check again", so saying which is
 * the difference between a useful screen and a shrug.
 *
 * Matched on stable codes and status numbers only — a server error can carry an
 * endpoint, and an endpoint can carry a key, so the raw message is never shown.
 */
export function discoverFailureCopyV1(error: unknown): string {
  if (!error) return CONSOLE_DISCOVER_UNREACHABLE_COPY_V1;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';

  if (/\b404\b/.test(message) || message.includes('Cannot GET')) {
    return 'This server does not serve the Discover feed yet. The opportunity API is part of a newer build than the one deployed here — nothing is wrong with the chain or your wallet.';
  }
  if (message.includes('authentication_required') || /\b401\b/.test(message)) {
    return 'Your session is not valid for this server, so the launch feed was not read. Signing in again is the fix.';
  }
  if (message.includes('b20_control_disabled')) {
    return 'B20 Discover is switched off on this server, so no launches are being read. This is not a statement about what is launching.';
  }
  if (message.includes('storage_unavailable')) {
    return 'Discover storage did not answer on this server, so no stored launches could be read. Nothing here is a statement about what is launching.';
  }
  if (name === 'ZodError' || message.includes('invalid_type') || message.includes('unrecognized_keys')) {
    // The specific failure a half-deployed stack produces, and the one that
    // looks most like "there is nothing out there" if it is not named.
    return 'This server answered with a launch feed this build does not understand. The API and this interface are on different versions.';
  }
  if (/\b5\d\d\b/.test(message)) {
    return 'The server failed while reading the launch feed. Nothing here is a statement about what is launching.';
  }
  return CONSOLE_DISCOVER_UNREACHABLE_COPY_V1;
}

/**
 * T70 §1 — the home screen.
 *
 * The rule that matters is the negative one: Opportunities may render an empty
 * card list ONLY when the pipeline is healthy. Every other state routes the
 * user somewhere useful or shows the pipeline's own sentence, because "no
 * opportunities" and "nothing is running" look identical from an empty array
 * and mean opposite things.
 */
export function consoleHomeSectionV1(input: ConsoleHomeInputV1): ConsoleHomeV1 {
  const { pipeline } = input;

  if (pipeline === null) {
    return {
      section: input.walletConnected ? 'portfolio' : 'routes',
      notice: CONSOLE_DISCOVER_UNREACHABLE_COPY_V1,
      feedRenderable: false,
    };
  }

  if (DISCOVER_UNAVAILABLE_V1.has(pipeline.state)) {
    // Portfolio still works without Discover — it reads the chain directly for
    // tokens the user already holds. Routes works without a wallet.
    return {
      section: input.walletConnected ? 'portfolio' : 'routes',
      notice: pipeline.message,
      feedRenderable: false,
    };
  }

  if (pipeline.state === 'healthy') {
    return {
      section: 'opportunities',
      notice: input.observationCount > 0 ? null : pipeline.message,
      feedRenderable: true,
    };
  }

  // Catching up, waiting on measurement, never started, or degraded: the
  // surface is the right one, but the pipeline speaks first and any cards it
  // does have are shown underneath.
  return {
    section: 'opportunities',
    notice: pipeline.message,
    feedRenderable: input.observationCount > 0,
  };
}

// ---------------------------------------------------------------------------
// T70 §2 — the compact paid-evidence status
// ---------------------------------------------------------------------------

export interface PaidEvidenceStripV1 {
  /** "Paid evidence: Off" / "Paid evidence: Active". */
  label: string;
  /** What still works. Never blank: the point of the strip is reassurance. */
  detail: string;
  /**
   * Whether to offer the Settings link. False when there is no Settings surface
   * mounted — the strip then states the situation and stops.
   */
  settingsAvailable: boolean;
  /**
   * Present when the user might otherwise expect a control here and there is
   * none. §2: no fake configure button while the permission flow does not
   * exist.
   */
  permissionNotice: string | null;
}

export const CONSOLE_PERMISSION_UNAVAILABLE_COPY_V1 =
  'Granting a wallet spending permission is not available yet, so paid evidence cannot be switched on from here.';

export interface PaidEvidenceStripInputV1 {
  /** From `paidIntelligenceViewV1`. */
  label: string;
  moneyAtRisk: boolean;
  /** True when the state's remedy is `create_permission`. */
  needsPermission: boolean;
  /** Whether that flow is actually built. */
  permissionFlowAvailable: boolean;
  settingsAvailable: boolean;
}

/**
 * The one-line form of Budget & payments.
 *
 * T70 §2 takes the full panel off the top of Home and Routes. It is not
 * deleted — it is a thing you adjust occasionally and read never, and it was
 * occupying the first screen of a product whose first screen should be an
 * opportunity or an action.
 */
export function paidEvidenceStripV1(input: PaidEvidenceStripInputV1): PaidEvidenceStripV1 {
  return {
    label: `Paid evidence: ${input.label}`,
    detail: input.moneyAtRisk
      ? 'A charge needs reconciliation. Open Settings — free comparison is unaffected.'
      : 'Free comparison available',
    settingsAvailable: input.settingsAvailable,
    permissionNotice:
      input.needsPermission && !input.permissionFlowAvailable ? CONSOLE_PERMISSION_UNAVAILABLE_COPY_V1 : null,
  };
}

// ---------------------------------------------------------------------------
// T70 §7 — the empty right rail
// ---------------------------------------------------------------------------

export const CONSOLE_NO_ANALYSIS_TITLE_V1 = 'No active analysis';
export const CONSOLE_NO_ANALYSIS_COPY_V1 =
  'Price, pool depth, evidence, spend and freshness appear here once a goal is running. Nothing has been measured yet.';

/**
 * Whether the right rail has anything to say.
 *
 * Four empty panels stacked down a 330px column read as four separate failures.
 * They are one fact — nothing has been asked yet — and it is stated once.
 */
export function rightRailHasContentV1(model: {
  price: unknown;
  depth: unknown;
  spend: unknown;
  evidenceFeed: readonly unknown[];
  freshness: readonly unknown[];
}): boolean {
  return Boolean(
    model.price ||
      model.depth ||
      model.spend ||
      model.evidenceFeed.length > 0 ||
      model.freshness.length > 0,
  );
}
