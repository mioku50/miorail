import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BASE_MCP_CAPABILITY_COPY_V1,
  baseMcpStatusCopyV1,
  groupBaseMcpToolsV1,
  type BaseMcpToolRowV1,
} from '../src/console/BaseMcpExtensionsCard';

const tool = (name: string, capability: BaseMcpToolRowV1['capability']): BaseMcpToolRowV1 => ({
  name,
  capability,
  scope: 'wallet',
});

describe('a third-party catalogue is grouped by what it may do, not by name', () => {
  test('what works comes first, what will not run comes last', () => {
    const groups = groupBaseMcpToolsV1([
      tool('z_forbidden', 'forbidden'),
      tool('a_unknown', 'unknown'),
      tool('m_write', 'user_confirmed_transaction'),
      tool('b_read', 'read_only'),
    ]);
    assert.deepEqual(
      groups.map((group) => group.capability),
      ['read_only', 'user_confirmed_transaction', 'unknown', 'forbidden'],
    );
  });

  test('an empty capability is not rendered as an empty heading', () => {
    const groups = groupBaseMcpToolsV1([tool('only_read', 'read_only')]);
    assert.equal(groups.length, 1);
  });

  test('unknown is described as not callable, never as probably fine', () => {
    // A tool the classifier has never seen might read, and might move money.
    // Showing it as available because it is probably harmless is the exact
    // assumption a catalogue of other people's code must not make.
    assert.match(BASE_MCP_CAPABILITY_COPY_V1.unknown, /not callable/i);
    assert.match(BASE_MCP_CAPABILITY_COPY_V1.forbidden, /not callable/i);
  });

  test('a write tool says who signs, and it is not Miorail', () => {
    const copy = BASE_MCP_CAPABILITY_COPY_V1.user_confirmed_transaction;
    assert.match(copy, /Base Account/);
    assert.match(copy, /never signs/i);
  });
});

describe('the connection line tells a user whether to act', () => {
  test('an unreachable server is not a claim about the plugins', () => {
    assert.match(baseMcpStatusCopyV1('unreachable', true), /Nothing here is a statement about which plugins/i);
  });

  test('a partial answer says the list may be incomplete', () => {
    assert.match(baseMcpStatusCopyV1('degraded', true), /incomplete/i);
  });

  test('the feature being off outranks any status', () => {
    assert.match(baseMcpStatusCopyV1('connected', false), /switched off/i);
  });

  test('never connected is not the same sentence as expired', () => {
    assert.notEqual(baseMcpStatusCopyV1(null, true), baseMcpStatusCopyV1('needs_reauth', true));
    assert.match(baseMcpStatusCopyV1('needs_reauth', true), /expired/i);
  });
});
