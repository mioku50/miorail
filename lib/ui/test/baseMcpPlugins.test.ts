import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BASE_MCP_PLUGIN_REACH_COPY_V1,
  baseMcpPluginDriftCopyV1,
  baseMcpPluginReachV1,
  groupBaseMcpPluginsV1,
  type BaseMcpPluginDriftRowV1,
  type BaseMcpPluginRowV1,
} from '../src/console/BaseMcpPluginsCard';

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
