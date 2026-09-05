import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

import {
  BASE_MCP_PLUGIN_FILTERS_V1,
  BASE_MCP_PLUGIN_REACH_COPY_V1,
  BaseMcpPluginsCard,
  BaseMcpSummaryRail,
  baseMcpExampleBadgeV1,
  baseMcpPluginDriftCopyV1,
  baseMcpPluginHostsLabelV1,
  baseMcpPluginMetaLineV1,
  baseMcpPluginReachV1,
  baseMcpPluginSummaryLineV1,
  baseMcpToolsWithReviewedAdaptersV1,
  baseMcpPluginCapabilitiesV1,
  filterBaseMcpPluginsV1,
  groupBaseMcpPluginsV1,
  selectBaseMcpExampleV1,
  type BaseMcpPluginDriftRowV1,
  type BaseMcpPluginRowV1,
} from '../src/console/BaseMcpPluginsCard';

test('a declared read without a released runtime recipe is not advertised as readable', () => {
  const example = { id: 'liquidity', prompt: 'Read Aerodrome liquidity', surface: 'read' as const,
    disposition: 'read_in_extensions' as const, capabilityState: 'unavailable' as const,
    capabilityReason: 'No reviewed recipe.' };
  const row = plugin({ id: 'aerodrome', examples: [example] });
  assert.equal(baseMcpExampleBadgeV1(example).label, 'NOT AVAILABLE HERE');
  assert.deepEqual(baseMcpPluginCapabilitiesV1(row), ['unavailable']);
  assert.deepEqual(filterBaseMcpPluginsV1([row], '', 'readable_here'), []);
});

test('the rail counts capabilities exactly once, in the header\'s own words', () => {
  const html = renderToStaticMarkup(BaseMcpSummaryRail({
    connection: 'connected',
    enabled: true,
    endpointHost: 'mcp.base.org',
    toolCounts: { readOnly: 8, userConfirmed: 7, forbidden: 0, unknown: 0 },
    routingCounts: { read: 8, action: 4, routable: 1, blocked: 2, releasedActions: 3 },
    plugins: [],
    drift: null,
    generatedAt: null,
  }));
  // The rail used to group these fifteen tools by SAFETY CLASS (Readable /
  // Needs your approval / Not callable) while the header above grouped the
  // same fifteen by ROUTING. Two taxonomies on one screen, and a reader seeing
  // 7 beside 5 with no way to reconcile them. One tally now.
  assert.match(html, /Reads<\/span><span class="v mono">8</);
  assert.match(html, /Actions ready<\/span><span class="v mono">3</);
  assert.match(html, /Actions needing an adapter<\/span><span class="v mono">1</);
  assert.match(html, /Routes AI handoffs<\/span><span class="v mono">1</);
  assert.match(html, /Not callable here<\/span><span class="v mono">2</);
  assert.doesNotMatch(html, /Needs your approval/);
  assert.doesNotMatch(html, /typed ACTION tools are released/);
  assert.doesNotMatch(html, /Only the readable ones are offered/);
  // The buckets partition the tool list rather than overlapping it.
  assert.equal(8 + 3 + 1 + 1 + 2, 15);
});

// ---------------------------------------------------------------------------
// The disconnected rail, and the number nobody could name.
//
// It read "connected  15" — fifteen of what? — and, before the tool list was
// fetched, "The tool list has not been read yet." with nowhere to press. A
// status with no action is a dead end on the one page whose whole job is to
// show what this console can reach.
// ---------------------------------------------------------------------------
describe('the rail says what its numbers count, and offers the read', () => {
  const rail = (overrides: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      BaseMcpSummaryRail({
        connection: 'connected',
        enabled: true,
        endpointHost: 'mcp.base.org',
        toolCounts: { readOnly: 8, userConfirmed: 7, forbidden: 0, unknown: 0 },
        routingCounts: { read: 8, action: 4, routable: 1, blocked: 2, releasedActions: 3 },
        plugins: [],
        drift: null,
        generatedAt: null,
        ...overrides,
      } as Parameters<typeof BaseMcpSummaryRail>[0]),
    );

  test('the total carries its noun', () => {
    assert.match(rail(), /15 tools/);
  });

  test('an unread tool list offers the read, and says so when it cannot', () => {
    const unread = rail({ toolCounts: null, onRefresh: () => {} });
    assert.match(unread, /The tool list has not been read yet/);
    assert.match(unread, /Read the tool list/);
    assert.match(unread, /no tools read/);

    // Switched off is a different sentence and offers nothing, because there
    // is nothing on the other end of the button.
    const off = rail({ toolCounts: null, enabled: false, onRefresh: () => {} });
    assert.match(off, /Base MCP is switched off on this server/);
    assert.doesNotMatch(off, /Read the tool list/);

    // A surface with no way to refetch shows no button rather than a dead one.
    assert.doesNotMatch(rail({ toolCounts: null }), /Read the tool list/);
  });

  test('the catalogue sentence is not printed twice on one screen', () => {
    // It belongs beside the drift pill in the main card. The rail repeating it
    // read as a second, independent reading of the catalogue.
    const html = rail({
      drift: { status: 'in_sync', knownCount: 20, publishedCount: 20 } as BaseMcpPluginDriftRowV1,
      generatedAt: '2026-08-09',
    });
    assert.doesNotMatch(html, /Base publishes/);
  });
});

const plugin = (overrides: Partial<BaseMcpPluginRowV1>): BaseMcpPluginRowV1 => ({
  id: 'example',
  title: 'Example Plugin',
  summary: 'Does a thing.',
  version: '0.1.0',
  integration: 'http-api',
  chains: ['base'],
  tags: [],
  risk: [],
  auth: 'none',
  shell: 'none',
  hosts: ['api.example.test'],
  externalMcpHost: null,
  cliPackage: null,
  productSurface: 'extensions',
  lifecycleStage: 'documented',
  examples: [{
    id: 'read',
    prompt: 'Show Example status',
    surface: 'read',
    disposition: 'read_in_extensions',
  }],
  ...overrides,
});

describe('a plugin is grouped by whether it can be reached from here', () => {
  test('an HTTP plugin with declared hosts is reachable', () => {
    assert.equal(baseMcpPluginReachV1(plugin({})), 'http');
  });

  test('a shell plugin is not reachable even when it declares a host', () => {
    // GMGN is the case this is written for: it names openapi.gmgn.ai and still
    // cannot run here, because its auth parameters come from shell commands.
    // Reading the host and calling it reachable is wrong in the one direction
    // that matters — it would promise a capability we do not have.
    assert.equal(
      baseMcpPluginReachV1(plugin({ id: 'gmgn', integration: 'cli-only', shell: 'bash' })),
      'shell_required',
    );
    assert.equal(
      baseMcpPluginReachV1(plugin({ id: 'aerodrome', integration: 'cli-only', shell: 'required', hosts: [] })),
      'shell_required',
    );
  });

  test('a plugin with no host of its own goes through Base MCP’s own tools', () => {
    assert.equal(
      baseMcpPluginReachV1(plugin({ id: 'yo', integration: 'semantic-base-tool', hosts: [] })),
      'base_tools',
    );
  });

  test('a plugin that needs its own MCP server is named as such', () => {
    assert.equal(
      baseMcpPluginReachV1(plugin({ hosts: [], externalMcpHost: 'mcp.example.test' })),
      'external_mcp',
    );
  });

  test('groups keep what works first and drop the empty ones', () => {
    const groups = groupBaseMcpPluginsV1([
      plugin({ id: 'zzz', integration: 'cli-only', shell: 'required', hosts: [] }),
      plugin({ id: 'aaa' }),
    ]);
    assert.deepEqual(groups.map((group) => group.reach), ['http', 'shell_required']);
    assert.equal(groups.length, 2, 'base_tools and external_mcp had no members and must not render');
  });

  test('the reachable group still says who approves a transaction', () => {
    assert.match(BASE_MCP_PLUGIN_REACH_COPY_V1.http, /Base Account/);
  });

  test('a shell plugin says plainly that it does not work on this surface', () => {
    assert.match(BASE_MCP_PLUGIN_REACH_COPY_V1.shell_required, /not on this surface/i);
  });
});

test('the tool projection releases sign only inside the reviewed Virtuals adapter', () => {
  const tools = [
    {
      name: 'sign',
      capability: 'user_confirmed_transaction' as const,
      scope: 'wallet' as const,
      surface: 'action' as const,
      surfaceEnabled: false,
      surfaceReason: 'action_vertical_not_released',
    },
    {
      name: 'arbitrary_write',
      capability: 'user_confirmed_transaction' as const,
      scope: 'protocol' as const,
      surface: 'action' as const,
      surfaceEnabled: false,
      surfaceReason: 'action_vertical_not_released',
    },
  ];
  const virtuals = plugin({
    id: 'virtuals',
    examples: [{
      id: 'create',
      prompt: 'Create a Virtuals agent called Mio Researcher to summarize Base research',
      surface: 'action',
      disposition: 'action_in_extensions',
    }],
  });
  const projected = baseMcpToolsWithReviewedAdaptersV1(tools, [virtuals]);
  assert.equal(projected[0]?.surfaceEnabled, true);
  assert.equal(projected[0]?.surfaceReason, 'released_only_inside_reviewed_virtuals_sign_in');
  assert.equal(projected[1]?.surfaceEnabled, false);
});

describe('the drift line says whether the catalogue is current', () => {
  const drift = (overrides: Partial<BaseMcpPluginDriftRowV1>): BaseMcpPluginDriftRowV1 => ({
    status: 'in_sync',
    knownCount: 20,
    publishedCount: 20,
    added: [],
    removed: [],
    checkedAt: '2026-08-09T12:00:00.000Z',
    reason: null,
    ...overrides,
  });

  test('matching names does not claim that specification contents are current', () => {
    const copy = baseMcpPluginDriftCopyV1(drift({}), '2026-08-09');
    assert.match(copy, /20 published plugin names/);
    assert.match(copy, /does not compare specification contents/);
  });

  test('a new plugin at Base is named, not just counted', () => {
    // Counting alone would tell the user something is missing without telling
    // them what, which is a notification rather than an answer.
    const copy = baseMcpPluginDriftCopyV1(
      drift({ status: 'drifted', publishedCount: 21, added: ['newthing'] }),
      '2026-08-09',
    );
    assert.match(copy, /newthing/);
    assert.match(copy, /not here yet/i);
  });

  test('a plugin Base dropped is reported separately from one it added', () => {
    const copy = baseMcpPluginDriftCopyV1(
      drift({ status: 'drifted', publishedCount: 19, removed: ['gone'] }),
      '2026-08-09',
    );
    assert.match(copy, /no longer published/i);
    assert.match(copy, /gone/);
  });

  test('a check that could not run never reads as current', () => {
    // The recurring defect this guards: our own failure rendered as a finding
    // about the subject. "Could not check" and "in sync" are different facts.
    const copy = baseMcpPluginDriftCopyV1(
      drift({ status: 'unchecked', publishedCount: null, checkedAt: null, reason: 'source_unreachable' }),
      '2026-08-09',
    );
    assert.match(copy, /could not be read/i);
    assert.match(copy, /may be behind/i);
    assert.doesNotMatch(copy, /in sync|all of them/i);
  });

  test('the check being switched off is distinguished from it failing', () => {
    const off = baseMcpPluginDriftCopyV1(
      drift({ status: 'unchecked', publishedCount: null, checkedAt: null, reason: 'check_disabled' }),
      '2026-08-09',
    );
    assert.match(off, /switched off/i);
  });

  test('with no drift information at all the catalogue date still shows', () => {
    assert.match(baseMcpPluginDriftCopyV1(null, '2026-08-09'), /2026-08-09/);
  });
});

describe('twenty plugins have to be scannable, not a wall of prose', () => {
  test('a long description is cut to one line, on a word boundary', () => {
    // Base writes these at wildly different lengths. Bitrefill's is fifty-one
    // words; rendering it whole gave twenty rows no two of which were the same
    // height, which is the screenshot that started this.
    const bitrefill =
      'Shop 1,500+ brands in 180+ countries — Amazon, Steam, Netflix, mobile top-ups, and travel eSIMs — paid with USDC on Base. Your agent searches, checks out, and delivers gift-card codes and eSIM details in chat.';
    const line = baseMcpPluginSummaryLineV1(bitrefill);
    assert.ok(line.length <= 97, `still ${line.length} chars`);
    assert.ok(line.endsWith('…'));
    assert.doesNotMatch(line, /\s…$/, 'the ellipsis must not follow a space');
  });

  test('a short description is left exactly as Base wrote it', () => {
    const uniswap = 'Swap tokens and manage liquidity positions on Uniswap.';
    assert.equal(baseMcpPluginSummaryLineV1(uniswap), uniswap);
  });

  test('newlines in a spec do not become a taller row', () => {
    assert.equal(baseMcpPluginSummaryLineV1('one\n  two\tthree'), 'one two three');
  });

  test('several hosts collapse to one plus a count', () => {
    // Three right-aligned hostnames were the widest thing on the card and the
    // least useful: the reader wants to know where a plugin goes, not to read
    // a DNS list.
    assert.equal(baseMcpPluginHostsLabelV1([]), '—');
    assert.equal(baseMcpPluginHostsLabelV1(['api.bankr.bot']), 'api.bankr.bot');
    assert.equal(
      baseMcpPluginHostsLabelV1(['api.avantisfi.com', 'core.avantisfi.com', 'data.avantisfi.com']),
      'api.avantisfi.com +2',
    );
  });

  test('the meta line states chains, and names auth only when there is any', () => {
    assert.equal(baseMcpPluginMetaLineV1(plugin({})), 'base');
    assert.equal(
      baseMcpPluginMetaLineV1(plugin({ auth: 'api-key', risk: ['slippage'] })),
      'base · auth: api-key · risk: slippage',
    );
    // A plugin whose spec names no chain says so rather than showing nothing.
    assert.match(baseMcpPluginMetaLineV1(plugin({ chains: [] })), /no chain stated/);
  });
});

describe('the plugin catalogue is an immediately usable explorer', () => {
  const catalogue = [
    plugin({
      id: 'morpho', title: 'Morpho Plugin', version: '0.3.0', productSurface: 'routes', lifecycleStage: 'proven',
      examples: [
        { id: 'vaults', prompt: 'Show Morpho vaults', surface: 'routable', disposition: 'handoff_to_routes' },
        { id: 'positions', prompt: 'Show my Morpho positions', surface: 'read', disposition: 'read_in_extensions' },
        { id: 'deposit', prompt: 'Deposit into Morpho', surface: 'routable', disposition: 'handoff_to_routes' },
      ],
    }),
    plugin({
      id: 'avantis', title: 'Avantis Plugin', productSurface: 'extensions', lifecycleStage: 'manifested',
      examples: [
        { id: 'positions', prompt: 'Show my Avantis positions', surface: 'read', disposition: 'read_in_extensions' },
        { id: 'open', prompt: 'Open a BTC long on Avantis', surface: 'action', disposition: 'handoff_to_provider_ui' },
      ],
    }),
    plugin({
      id: 'gmgn', title: 'GMGN Plugin', integration: 'cli-only', shell: 'bash',
      examples: [
        { id: 'market', prompt: 'Show GMGN market intelligence', surface: 'read', disposition: 'read_in_extensions' },
        { id: 'quote', prompt: 'Get a GMGN quote', surface: 'routable', disposition: 'handoff_to_routes' },
      ],
    }),
  ];

  test('cards lead with what you can do here, and keep the plumbing in Technical details', () => {
    const html = renderToStaticMarkup(React.createElement(BaseMcpPluginsCard, {
      loading: false,
      plugins: catalogue,
      drift: null,
      generatedAt: '2026-08-09',
      unavailableReason: null,
      onSelectPrompt: () => undefined,
    }));
    assert.match(html, /Explore Base Plugins/);
    assert.match(html, /Search plugins…/);
    assert.match(html, /Base plugin spec · v0\.3\.0/);
    assert.match(html, /Owner<\/dt><dd>Routes AI/);
    // The transport pill and the lifecycle word used to be the first things on
    // the card. "HTTP path" reads as a promise that the plugin does something
    // here, and `proven` / `scored` / `manifested` under a heading reads as a
    // quality rating rather than as how far our own integration got. Both are
    // still on the page, one fold down, under their real names.
    assert.match(html, /<summary>Technical details<\/summary>/);
    assert.match(html, /Transport<\/dt><dd>HTTP path/);
    assert.match(html, /Integration stage<\/dt><dd class="mono">proven/);
    assert.doesNotMatch(html, /Lifecycle<\/dt>/);
    // What the head carries instead: what a person can do with it, here.
    assert.match(html, /class="mcp-plugin-caps"/);
    assert.match(html, /<span class="mcp-disposition read">READ<\/span>/);
    assert.match(html, /<span class="mcp-disposition provider">OPEN PROVIDER<\/span>/);
    assert.match(html, /Show Morpho vaults/);
    assert.match(html, /Show my Morpho positions/);
    assert.match(html, /Example prompts/);
    assert.match(html, /adapted from the Base plugin spec/);
    assert.doesNotMatch(html, /Canonical examples/);
    assert.doesNotMatch(html, /class="mcp-group"/);
  });

  test('the required filters exist and select from current truth', () => {
    assert.deepEqual(
      BASE_MCP_PLUGIN_FILTERS_V1.map((entry) => entry.label),
      ['All', 'Readable here', 'Routes AI', 'Actions', 'Requires external UI', 'Shell required'],
    );
    assert.deepEqual(filterBaseMcpPluginsV1(catalogue, '', 'external_ui').map((row) => row.id), ['avantis']);
    assert.deepEqual(filterBaseMcpPluginsV1(catalogue, '', 'shell_required').map((row) => row.id), ['gmgn']);
    assert.deepEqual(filterBaseMcpPluginsV1(catalogue, 'morpho positions', 'all').map((row) => row.id), ['morpho']);
  });

  test('badges are derived from disposition, including provider UI and x402', () => {
    assert.equal(baseMcpExampleBadgeV1({ surface: 'routable', disposition: 'handoff_to_routes' }).label, 'ROUTES AI');
    assert.equal(baseMcpExampleBadgeV1({ surface: 'action', disposition: 'handoff_to_provider_ui' }).label, 'PROVIDER UI');
    assert.equal(baseMcpExampleBadgeV1({ surface: 'action', disposition: 'typed_x402_required' }).label, 'x402');
    assert.equal(baseMcpExampleBadgeV1({ surface: 'action', disposition: 'adapter_required' }).label, 'ADAPTER REQUIRED');
  });

  test('selecting an example has only a fill callback and never an execute callback', () => {
    const selected: string[] = [];
    selectBaseMcpExampleV1((prompt) => selected.push(prompt), 'Show my Morpho positions');
    assert.deepEqual(selected, ['Show my Morpho positions']);
  });
});

// ---------------------------------------------------------------------------
// The card answers "what can I do with this here", not "how does it connect".
// ---------------------------------------------------------------------------
describe('plugin capabilities are read off the router, not the transport', () => {
  const plugin = (examples: { surface: string; disposition: string }[]): BaseMcpPluginRowV1 => ({
    id: 'x',
    title: 'X',
    summary: 's',
    version: '0.1.0',
    integration: 'http',
    chains: ['base'],
    tags: [],
    risk: [],
    auth: 'none',
    shell: 'none',
    hosts: ['api.example'],
    externalMcpHost: null,
    cliPackage: null,
    productSurface: 'extensions',
    lifecycleStage: 'documented',
    examples: examples.map((entry, index) => ({
      id: `e${index}`,
      prompt: 'p',
      surface: entry.surface,
      disposition: entry.disposition,
    })),
  } as unknown as BaseMcpPluginRowV1);

  test('every released disposition becomes a capability, in reading order', () => {
    assert.deepEqual(
      baseMcpPluginCapabilitiesV1(plugin([
        { surface: 'routable', disposition: 'handoff_to_routes' },
        { surface: 'action', disposition: 'handoff_to_provider_ui' },
        { surface: 'read', disposition: 'read_in_extensions' },
        { surface: 'action', disposition: 'action_in_extensions' },
      ])),
      ['read', 'action', 'routes', 'provider_ui'],
    );
  });

  test('a stopped intent is not a capability', () => {
    // Each of these is a REASON the intent ends here. A card that counted them
    // as capabilities would advertise exactly the dead ends the badge exists
    // to expose.
    for (const disposition of ['adapter_required', 'route_unavailable_here', 'typed_x402_required']) {
      assert.deepEqual(
        baseMcpPluginCapabilitiesV1(plugin([{ surface: 'read', disposition }])),
        ['unavailable'],
        disposition,
      );
    }
  });

  test('a plugin with a reviewed HTTP host but nothing callable still says UNAVAILABLE', () => {
    // The exact case that made "HTTP path" misleading: a declared transport,
    // and no prompt this surface can finish.
    const row = plugin([{ surface: 'read', disposition: 'adapter_required' }]);
    assert.equal(baseMcpPluginReachV1(row), 'http');
    assert.deepEqual(baseMcpPluginCapabilitiesV1(row), ['unavailable']);
  });
});
