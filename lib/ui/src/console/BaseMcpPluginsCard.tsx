import React, { useMemo, useState } from 'react';
import type { BaseMcpToolRowV1 } from './BaseMcpExtensionsCard';

// The app uses the automatic JSX runtime; the node render suite uses the
// classic transform and needs this binding.
void React;

// ---------------------------------------------------------------------------
// The Base MCP plugin catalogue — the thing this screen was named after and
// did not contain.
//
// Extensions shipped with one card headed "Base MCP plugins" that listed
// `get_portfolio`, `send`, `swap` and a dozen others. Those are Base MCP's
// CORE TOOLS: the fifteen calls the server itself exposes. The plugins are a
// different layer — twenty markdown specifications Base publishes, each one a
// protocol (Uniswap, Morpho, OpenSea, Aerodrome…) with its own hosts, its own
// auth and its own risks. Not one of them appeared. The heading was a promise
// the card never kept, and a user who opened the page to see what was
// available saw the plumbing instead.
//
// Two facts decide how this renders.
//
//   * The catalogue is COMMITTED, because it carries the host allowlist.
//     A boundary that refreshes itself from the network is one nobody reviews.
//   * A committed catalogue goes stale, and staleness that nobody can see is
//     indistinguishable from being current. So the drift line is not
//     decoration: it is the difference between "Base publishes twenty and we
//     know all twenty" and "we have no idea, and this list may be behind".
//
// The three drift states stay three. A check that could not run is `unchecked`
// — never `in_sync`, never "Base removed everything". Our own outage does not
// get to wear Base's name.
// ---------------------------------------------------------------------------

export interface BaseMcpPluginRowV1 {
  id: string;
  title: string;
  summary: string;
  version: string;
  integration: string;
  chains: readonly string[];
  tags: readonly string[];
  /** Base's own risk labels: slippage, liquidation, irreversible, pii… */
  risk: readonly string[];
  auth: string;
  shell: string;
  hosts: readonly string[];
  externalMcpHost: string | null;
  cliPackage: string | null;
  productSurface: 'routes' | 'extensions';
  lifecycleStage: 'documented' | 'manifested' | 'adapter' | 'scored' | 'proven';
  examples: readonly {
    id: string;
    prompt: string;
    surface: 'read' | 'action' | 'routable';
    disposition: 'read_in_extensions' | 'handoff_to_routes' | 'handoff_to_provider_ui' | 'typed_x402_required' | 'action_in_extensions' | 'adapter_required';
  }[];
}

export interface BaseMcpPluginDriftRowV1 {
  status: 'in_sync' | 'drifted' | 'unchecked';
  knownCount: number;
  publishedCount: number | null;
  added: readonly string[];
  removed: readonly string[];
  checkedAt: string | null;
  reason: string | null;
}

export interface BaseMcpPluginsModelV1 {
  loading: boolean;
  plugins: readonly BaseMcpPluginRowV1[];
  drift: BaseMcpPluginDriftRowV1 | null;
  /** The date the committed catalogue was read from Base. */
  generatedAt: string | null;
  /** Rendered INSTEAD of the list. Never alongside a partial one. */
  unavailableReason: string | null;
  /** Selecting an example only fills the console. It never executes it. */
  onSelectPrompt?: (prompt: string) => void;
}

/**
 * The live Base MCP inventory classifies `sign` as blocked in the generic
 * console, correctly. A reviewed provider adapter may release that primitive
 * only inside its own exact state machine. Project that narrower truth into
 * the catalogue/tool UI without making arbitrary signing look callable.
 */
export function baseMcpToolsWithReviewedAdaptersV1(
  tools: readonly BaseMcpToolRowV1[],
  plugins: readonly BaseMcpPluginRowV1[],
): BaseMcpToolRowV1[] {
  const virtualsSignInReleased = plugins.some((plugin) =>
    plugin.id === 'virtuals'
    && plugin.examples.some((example) => example.disposition === 'action_in_extensions'),
  );
  if (!virtualsSignInReleased) return [...tools];
  const signNames = new Set(['sign', 'personalsign', 'signmessage']);
  return tools.map((tool) => {
    const normalizedName = tool.name.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (tool.surface !== 'action' || !signNames.has(normalizedName)) return tool;
    return {
      ...tool,
      surfaceEnabled: true,
      surfaceReason: 'released_only_inside_reviewed_virtuals_sign_in',
    };
  });
}

/** How a plugin would be reached from here — which is not the same question as
 * what it can do, and is the one that decides whether it works in Miorail. */
export type BaseMcpPluginReachV1 = 'http' | 'base_tools' | 'external_mcp' | 'shell_required';

export type BaseMcpPluginFilterV1 =
  | 'all'
  | 'readable_here'
  | 'routes_ai'
  | 'actions'
  | 'external_ui'
  | 'shell_required';

export type BaseMcpExampleDispositionUiV1 = BaseMcpPluginRowV1['examples'][number]['disposition'];

export interface BaseMcpExampleBadgeV1 {
  label: 'READ' | 'ROUTES AI' | 'ACTION' | 'PROVIDER UI' | 'ADAPTER REQUIRED' | 'x402';
  tone: 'read' | 'routes' | 'action' | 'provider' | 'adapter' | 'x402';
}

export interface BaseMcpExampleUiV1 {
  surface: 'read' | 'action' | 'routable';
  disposition: BaseMcpExampleDispositionUiV1;
}

/** A display label derived from routing metadata. The prompt never carries a
 * second hand-written label that could drift from its actual disposition. */
export function baseMcpExampleBadgeV1(example: BaseMcpExampleUiV1): BaseMcpExampleBadgeV1 {
  switch (example.disposition) {
    case 'handoff_to_routes':
      return { label: 'ROUTES AI', tone: 'routes' };
    case 'handoff_to_provider_ui':
      return { label: 'PROVIDER UI', tone: 'provider' };
    case 'typed_x402_required':
      return { label: 'x402', tone: 'x402' };
    case 'adapter_required':
      return { label: 'ADAPTER REQUIRED', tone: 'adapter' };
    case 'action_in_extensions':
      return { label: 'ACTION', tone: 'action' };
    default:
      return example.surface === 'action'
        ? { label: 'ACTION', tone: 'action' }
        : { label: 'READ', tone: 'read' };
  }
}

export function baseMcpPluginReachV1(plugin: BaseMcpPluginRowV1): BaseMcpPluginReachV1 {
  // Shell first, and deliberately before hosts: GMGN declares an API host and
  // still cannot run here, because its auth parameters are generated by shell
  // commands. Listing it as reachable because it named a host would be wrong
  // in the one direction that matters.
  if (plugin.integration === 'cli-only' || plugin.shell === 'required' || plugin.shell === 'bash') {
    return 'shell_required';
  }
  if (plugin.hosts.length > 0) return 'http';
  if (plugin.externalMcpHost) return 'external_mcp';
  return 'base_tools';
}

export const BASE_MCP_PLUGIN_REACH_COPY_V1: Readonly<Record<BaseMcpPluginReachV1, string>> = {
  http:
    'The Base spec declares an HTTP path Miorail may use. Runtime support still depends on the lifecycle and disposition shown below; anything it prepares is approved in your Base Account.',
  base_tools:
    'Uses Base MCP’s own tools and the chain directly — no API host of its own.',
  external_mcp:
    'Needs a separate MCP server. Not connected here.',
  shell_required:
    'Runs through a terminal. Miorail gives no shell, so this one works in a CLI client and not on this surface.',
};

const REACH_LABEL_V1: Readonly<Record<BaseMcpPluginReachV1, string>> = {
  http: 'HTTP path',
  base_tools: 'Base tools',
  external_mcp: 'External MCP',
  shell_required: 'Shell required',
};

/** console.css gives `.pill` exactly four tones — br, g, a, n. */
const REACH_TONE_V1: Readonly<Record<BaseMcpPluginReachV1, string>> = {
  http: 'g',
  base_tools: 'br',
  external_mcp: 'a',
  shell_required: 'n',
};

const REACH_ORDER_V1: readonly BaseMcpPluginReachV1[] = [
  'http',
  'base_tools',
  'external_mcp',
  'shell_required',
];

export function groupBaseMcpPluginsV1(
  plugins: readonly BaseMcpPluginRowV1[],
): { reach: BaseMcpPluginReachV1; plugins: BaseMcpPluginRowV1[] }[] {
  return REACH_ORDER_V1.map((reach) => ({
    reach,
    plugins: plugins
      .filter((plugin) => baseMcpPluginReachV1(plugin) === reach)
      .sort((left, right) => left.id.localeCompare(right.id)),
  })).filter((group) => group.plugins.length > 0);
}

export const BASE_MCP_PLUGIN_FILTERS_V1: readonly {
  id: BaseMcpPluginFilterV1;
  label: string;
}[] = [
  { id: 'all', label: 'All' },
  { id: 'readable_here', label: 'Readable here' },
  { id: 'routes_ai', label: 'Routes AI' },
  { id: 'actions', label: 'Actions' },
  { id: 'external_ui', label: 'Requires external UI' },
  { id: 'shell_required', label: 'Shell required' },
] as const;

function pluginMatchesFilterV1(plugin: BaseMcpPluginRowV1, filter: BaseMcpPluginFilterV1): boolean {
  const reach = baseMcpPluginReachV1(plugin);
  switch (filter) {
    case 'readable_here':
      return (reach === 'http' || reach === 'base_tools')
        && plugin.examples.some((example) => example.disposition === 'read_in_extensions');
    case 'routes_ai':
      return plugin.productSurface === 'routes'
        || plugin.examples.some((example) => example.disposition === 'handoff_to_routes');
    case 'actions':
      return plugin.examples.some((example) => example.surface === 'action');
    case 'external_ui':
      return plugin.examples.some((example) => example.disposition === 'handoff_to_provider_ui');
    case 'shell_required':
      return reach === 'shell_required';
    default:
      return true;
  }
}

export function filterBaseMcpPluginsV1(
  plugins: readonly BaseMcpPluginRowV1[],
  query: string,
  filter: BaseMcpPluginFilterV1,
): BaseMcpPluginRowV1[] {
  const needle = query.trim().toLocaleLowerCase();
  return plugins
    .filter((plugin) => pluginMatchesFilterV1(plugin, filter))
    .filter((plugin) => {
      if (!needle) return true;
      const haystack = [
        plugin.id,
        plugin.title,
        plugin.summary,
        ...plugin.tags,
        ...plugin.chains,
        ...plugin.examples.map((example) => example.prompt),
      ].join(' ').toLocaleLowerCase();
      return haystack.includes(needle);
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}

/** The only operation an example is allowed to perform. There is deliberately
 * no execute callback in this boundary. */
export function selectBaseMcpExampleV1(
  onSelectPrompt: ((prompt: string) => void) | undefined,
  prompt: string,
): void {
  onSelectPrompt?.(prompt);
}

/**
 * The drift sentence.
 *
 * Written so that the honest answer to "is this list current?" is legible in
 * one line, including when the answer is "nobody could tell".
 */
export function baseMcpPluginDriftCopyV1(
  drift: BaseMcpPluginDriftRowV1 | null,
  generatedAt: string | null,
): string {
  const read = generatedAt ? ` Catalogue read from Base on ${generatedAt}.` : '';
  if (!drift) return `Showing the plugins Miorail has on file.${read}`;

  if (drift.status === 'in_sync') {
    return `Base publishes ${drift.publishedCount ?? drift.knownCount} plugins and Miorail has all of them.${read}`;
  }
  if (drift.status === 'drifted') {
    const parts: string[] = [];
    if (drift.added.length > 0) {
      parts.push(`new at Base and not here yet: ${drift.added.join(', ')}`);
    }
    if (drift.removed.length > 0) {
      parts.push(`here but no longer published by Base: ${drift.removed.join(', ')}`);
    }
    return `Base publishes ${drift.publishedCount ?? '—'} plugins, Miorail has ${drift.knownCount} — ${parts.join('; ')}.${read}`;
  }
  const why =
    drift.reason === 'check_disabled'
      ? 'The check against Base’s list is switched off on this server'
      : 'Base’s list could not be read just now';
  return `${why}, so this may be behind. Showing the ${drift.knownCount} plugins Miorail has on file.${read}`;
}

const DRIFT_TONE_V1: Readonly<Record<BaseMcpPluginDriftRowV1['status'], string>> = {
  in_sync: 'g',
  drifted: 'a',
  unchecked: 'n',
};

const DRIFT_LABEL_V1: Readonly<Record<BaseMcpPluginDriftRowV1['status'], string>> = {
  in_sync: 'in sync with Base',
  drifted: 'behind Base',
  unchecked: 'not checked',
};

/** `base · ethereum · arbitrum`, or a stated absence. */
function chainsLabelV1(chains: readonly string[]): string {
  return chains.length > 0 ? chains.join(' · ') : 'no chain stated';
}

/**
 * The plugin's own description, cut to one line.
 *
 * Base writes these at wildly different lengths — Uniswap's is eight words,
 * Bitrefill's is fifty-one — and rendering them whole turned twenty plugins
 * into a wall of prose with no two rows the same height. A list you cannot
 * scan is a list nobody reads. The full text is one click away at the spec;
 * what this surface owes the reader is which plugins exist and what each one
 * touches.
 */
export function baseMcpPluginSummaryLineV1(summary: string, max = 96): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Cut on a word boundary so the ellipsis does not land mid-word.
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The second line of a plugin row: what it touches and what it costs to be
 * wrong about it. Base's own risk labels, not ours. */
export function baseMcpPluginMetaLineV1(plugin: BaseMcpPluginRowV1): string {
  const parts = [chainsLabelV1(plugin.chains)];
  if (plugin.auth && plugin.auth !== 'none' && plugin.auth !== 'unknown') {
    parts.push(`auth: ${plugin.auth}`);
  }
  if (plugin.risk.length > 0) parts.push(`risk: ${plugin.risk.join(', ')}`);
  return parts.join(' · ');
}

/** The right-hand column: where the plugin actually goes. One host, plus a
 * count when there are more — three full hostnames in a right-aligned mono
 * column is the widest, least readable thing on the card. */
export function baseMcpPluginHostsLabelV1(hosts: readonly string[]): string {
  if (hosts.length === 0) return '—';
  if (hosts.length === 1) return hosts[0]!;
  return `${hosts[0]} +${hosts.length - 1}`;
}

export function BaseMcpPluginsCard(model: BaseMcpPluginsModelV1) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BaseMcpPluginFilterV1>('all');
  const filtered = useMemo(
    () => filterBaseMcpPluginsV1(model.plugins, query, filter),
    [filter, model.plugins, query],
  );
  const drift = model.drift;

  const exampleButton = (
    plugin: BaseMcpPluginRowV1,
    example: BaseMcpPluginRowV1['examples'][number],
    className = '',
  ) => {
    const badge = baseMcpExampleBadgeV1(example);
    return (
      <button
        key={`${plugin.id}:${example.id}:${className}`}
        type="button"
        className={`mcp-example ${className}`.trim()}
        disabled={!model.onSelectPrompt}
        title="Fill the Base MCP AI Console — this does not execute the prompt"
        onClick={() => selectBaseMcpExampleV1(model.onSelectPrompt, example.prompt)}
      >
        <span className={`mcp-disposition ${badge.tone}`}>{badge.label}</span>
        <span>{example.prompt}</span>
      </button>
    );
  };

  return (
    <div className="rp mcp-explorer">
      <div className="rph">
        <b>Explore Base Plugins</b>
        <span className="rt mono">{model.plugins.length || '—'}</span>
      </div>
      <div className="rpb">
        {drift && (
          <div className="qrow">
            <span className={`pill ${DRIFT_TONE_V1[drift.status]}`}>{DRIFT_LABEL_V1[drift.status]}</span>
            <span className="v mono">
              {drift.publishedCount === null ? `${drift.knownCount}` : `${drift.knownCount}/${drift.publishedCount}`}
            </span>
          </div>
        )}
        <p className="lnote">{baseMcpPluginDriftCopyV1(drift, model.generatedAt)}</p>

        {model.loading && model.plugins.length === 0 ? (
          <p className="empty">Reading the plugin catalogue…</p>
        ) : model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : model.plugins.length === 0 ? (
          <p className="empty">No plugins on file.</p>
        ) : (
          <>
            <div className="mcp-explorer-controls">
              <label className="mcp-search-wrap">
                <span className="sr-only">Search plugins</span>
                <input
                  type="search"
                  className="mcp-search"
                  placeholder="Search plugins…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="mcp-filters" aria-label="Filter Base plugins">
                {BASE_MCP_PLUGIN_FILTERS_V1.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`btn sec ${filter === entry.id ? 'on' : ''}`}
                    aria-pressed={filter === entry.id}
                    onClick={() => setFilter(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <p className="empty">No plugins match this search and filter.</p>
            ) : (
              <div className="mcp-plugin-grid">
                {filtered.map((plugin) => {
                  const reach = baseMcpPluginReachV1(plugin);
                  const owner = plugin.productSurface === 'routes' ? 'Routes AI' : 'Base MCP Extensions';
                  const moreCount = Math.max(0, plugin.examples.length - 2);
                  return (
                    <article className="mcp-plugin-card" key={plugin.id} data-plugin-id={plugin.id}>
                      <div className="mcp-plugin-head">
                        <div>
                          <b>{plugin.title}</b>
                          <span className="mono">{plugin.id}</span>
                        </div>
                        <span className={`pill ${REACH_TONE_V1[reach]}`}>{REACH_LABEL_V1[reach]}</span>
                      </div>

                      <p className="mcp-plugin-summary">{baseMcpPluginSummaryLineV1(plugin.summary || plugin.title, 180)}</p>
                      <dl className="mcp-plugin-facts">
                        <div><dt>Chain</dt><dd>{chainsLabelV1(plugin.chains)}</dd></div>
                        <div><dt>Owner</dt><dd>{owner}</dd></div>
                        <div><dt>Lifecycle</dt><dd className="mono">{plugin.lifecycleStage}</dd></div>
                      </dl>
                      <p className="mcp-plugin-reach">{BASE_MCP_PLUGIN_REACH_COPY_V1[reach]}</p>
                      <p className="mcp-plugin-source">Base plugin spec · v{plugin.version}</p>

                      <div className="mcp-examples-head">
                        <b>Example prompts</b>
                        <span>adapted from the Base plugin spec</span>
                      </div>
                      <div className="mcp-examples">
                        {plugin.examples[0] && exampleButton(plugin, plugin.examples[0])}
                        {plugin.examples[1] && exampleButton(plugin, plugin.examples[1], 'mcp-desktop-second')}
                      </div>

                      {plugin.examples.length > 1 && (
                        <details className={`mcp-more ${plugin.examples.length === 2 ? 'two-only' : ''}`}>
                          <summary>
                            <span className="mcp-more-desktop">More examples ({moreCount})</span>
                            <span className="mcp-more-mobile">Examples ({plugin.examples.length})</span>
                          </summary>
                          <div className="mcp-examples">
                            {plugin.examples[1] && exampleButton(plugin, plugin.examples[1], 'mcp-mobile-second')}
                            {plugin.examples.slice(2).map((example) => exampleButton(plugin, example))}
                          </div>
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}

        <p className="lnote">
          Plugins are built by third parties. Base does not operate, endorse or audit them, and
          Miorail does not either — a plugin reaches only the hosts its own spec declares, and every
          transaction is approved in your Base Account. Selecting an example only fills the console;
          it never runs the prompt. Adding a new plugin here is a reviewed
          change, which is why the line above tells you when Base is ahead.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The right rail for the Base MCP Extensions surface.
//
// The column was empty while the page it sits beside carried three stacked
// cards and a 20-row catalogue in one scrolling column. Everything here is
// already loaded — none of it costs a request — and all of it answers the
// question a reader has while looking at that catalogue: what am I connected
// to, and how much of this can actually run.
// ---------------------------------------------------------------------------

export interface BaseMcpRailModelV1 {
  /** From the live tool probe. Null before it has answered once. */
  connection: 'connected' | 'needs_reauth' | 'unreachable' | 'degraded' | null;
  enabled: boolean;
  endpointHost: string | null;
  /** Live tool counts by what each one is allowed to do. */
  toolCounts: { readOnly: number; userConfirmed: number; forbidden: number; unknown: number } | null;
  routingCounts?: {
    read: number;
    action: number;
    routable: number;
    blocked: number;
    releasedActions: number;
  } | null;
  plugins: readonly BaseMcpPluginRowV1[];
  drift: BaseMcpPluginDriftRowV1 | null;
  generatedAt: string | null;
  /**
   * Read the tool list again. Optional so a surface that has no way to refetch
   * simply shows no button rather than one that does nothing.
   *
   * Without this the disconnected rail was a status and a dead end: it said the
   * list had not been read and left the reader with nowhere to press.
   */
  onRefresh?: () => void;
  refreshing?: boolean;
}

const CONNECTION_TONE_V1: Readonly<Record<string, string>> = {
  connected: 'g',
  degraded: 'a',
  needs_reauth: 'a',
  unreachable: 'n',
};

export function BaseMcpSummaryRail(model: BaseMcpRailModelV1) {
  const groups = groupBaseMcpPluginsV1(model.plugins);
  const counts = model.toolCounts;
  const routing = model.routingCounts;

  return (
    <>
      <div className="rp">
        <div className="rph">
          Base MCP
          {model.endpointHost && <span className="rt mono">{model.endpointHost}</span>}
        </div>
        <div className="rpb">
          <div className="qrow">
            <span className={`pill ${model.connection ? CONNECTION_TONE_V1[model.connection] ?? 'n' : 'n'}`}>
              {model.enabled ? (model.connection ?? 'not connected').replace(/_/g, ' ') : 'switched off'}
            </span>
            {/* The number used to sit here alone, so "15" beside "connected"
                could have been tools, plugins or minutes. */}
            <span className="v mono">
              {counts
                ? `${counts.readOnly + counts.userConfirmed + counts.forbidden + counts.unknown} tools`
                : 'no tools read'}
            </span>
          </div>
          {counts ? (
            <>
              <div className="qrow">
                <span>Readable</span>
                <span className="v mono">{counts.readOnly}</span>
              </div>
              <div className="qrow">
                <span>Needs your approval</span>
                <span className="v mono">{counts.userConfirmed}</span>
              </div>
              <div className="qrow">
                <span>Not callable here</span>
                <span className="v mono">{counts.forbidden + counts.unknown}</span>
              </div>
              <p className="lnote">
                The console can read and act. {routing
                  ? `${routing.releasedActions}/${routing.action} typed ACTION tools are released; ${routing.routable} ROUTABLE tools hand off to Routes AI; ${routing.blocked} still need an adapter or remain forbidden.`
                  : 'Each write still needs a typed adapter and your Base Account approval.'}
              </p>
            </>
          ) : (
            <>
              <p className="empty">
                {model.enabled
                  ? 'The tool list has not been read yet.'
                  : 'Base MCP is switched off on this server, so there is no tool list to read.'}
              </p>
              {model.enabled && model.onRefresh && (
                <button
                  type="button"
                  className="btn sec"
                  onClick={model.onRefresh}
                  disabled={model.refreshing === true}
                >
                  {model.refreshing === true ? 'Reading…' : 'Read the tool list'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="rp">
        <div className="rph">
          Plugins
          <span className="rt mono">{model.plugins.length || '—'}</span>
        </div>
        <div className="rpb">
          {groups.length === 0 ? (
            <p className="empty">No catalogue loaded.</p>
          ) : (
            groups.map((group) => (
              <div className="qrow" key={group.reach}>
                <span>{REACH_LABEL_V1[group.reach]}</span>
                <span className="v mono">{group.plugins.length}</span>
              </div>
            ))
          )}
          {/* The drift sentence is NOT repeated here. It sits in the main card
              beside the drift pill it explains, and printing it twice on one
              screen made the rail look like a second, independent reading. The
              rail keeps what it is for: how many plugins, reachable how. */}
        </div>
      </div>
    </>
  );
}
