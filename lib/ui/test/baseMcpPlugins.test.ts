import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BASE_MCP_PLUGIN_REACH_COPY_V1,
  BaseMcpSummaryRail,
  baseMcpPluginDriftCopyV1,
  baseMcpPluginHostsLabelV1,
  baseMcpPluginMetaLineV1,
  baseMcpPluginReachV1,
  baseMcpPluginSummaryLineV1,
  groupBaseMcpPluginsV1,
  type BaseMcpPluginDriftRowV1,
  type BaseMcpPluginRowV1,
} from '../src/console/BaseMcpPluginsCard';

test('the summary rail exposes released ACTION tools instead of calling the console read-only', () => {
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
  assert.match(html, /3\/4 typed ACTION tools are released/);
  assert.match(html, /hand off to Routes AI/);
  assert.doesNotMatch(html, /Only the readable ones are offered/);
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

  test('in sync states both numbers', () => {
    const copy = baseMcpPluginDriftCopyV1(drift({}), '2026-08-09');
    assert.match(copy, /20 plugins/);
    assert.match(copy, /all of them/i);
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

// ---------------------------------------------------------------------------
// P2 — twenty plugins at five lines each.
// ---------------------------------------------------------------------------
describe('the plugin catalogue folds, and keeps our own vocabulary one level down', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const card = readFileSync(path.join(here, '../src/console/BaseMcpPluginsCard.tsx'), 'utf8');

  test('each reach group folds', () => {
    assert.match(card, /<details className="mcp-group">/);
    assert.ok(!/className="mcp-group" open/.test(card));
  });

  test('owner and stage moved inside the row disclosure', () => {
    // Both are true and both are OURS: which Miorail surface owns the plugin,
    // and how far along our pipeline it is. Neither answers "what can this
    // console reach", which is the question the page exists for — so they are
    // kept, one fold down, rather than being the fourth line of twenty rows.
    const disclosureAt = card.indexOf('Details and example questions');
    const ownerAt = card.indexOf('Owner: <span className="mono">');
    assert.ok(disclosureAt > 0 && ownerAt > disclosureAt, 'owner/stage is still a top-level row');
    assert.match(card, /stage: <span className="mono">/);
  });
});

