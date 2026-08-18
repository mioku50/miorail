import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  BASE_MCP_CAPABILITY_COPY_V1,
  BaseMcpExtensionsCard,
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
  test('an unreachable server is not a claim about the tools', () => {
    assert.match(baseMcpStatusCopyV1('unreachable', true), /Nothing here is a statement about which tools/i);
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

// ---------------------------------------------------------------------------
// P2 — the page a reader scrolled past.
//
// Fifteen tool names under three headings, each name trailed by a bare
// `wallet` or `protocol` that nothing on the page defined, and a summary block
// naming the same counts in the wire's own capitals.
// ---------------------------------------------------------------------------
describe('the tool catalogue is scannable, and its column is named', () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const card = readFileSync(path.join(here, '../src/console/BaseMcpExtensionsCard.tsx'), 'utf8');

  test('each capability group folds, so the headings are what is scanned', () => {
    assert.match(card, /<details key=\{group\.capability\} className="mcp-group">/);
    // Closed by default: `<details>` with no `open`.
    assert.ok(!/className="mcp-group" open/.test(card));
  });

  test('the scope word is explained once, not repeated on every row', () => {
    assert.match(card, /The word beside each tool is what it touches/);
    assert.match(card, /needs\s*\n?\s*your Base Account/);
  });

  test('the summary uses the same words as the header and the rail', () => {
    for (const shouted of ['<span>READ</span>', '<span>ACTION</span>', '<span>ROUTABLE</span>']) {
      assert.ok(!card.includes(shouted), `${shouted} is still shouted at the reader`);
    }
    assert.match(card, /Readable here/);
    assert.match(card, /Need your approval/);
    assert.match(card, /Hand off to Routes AI/);
  });
});

test('the column is explained once for the list, not once per heading', () => {
  // Rendered, not grepped: the note started life inside the group loop, where
  // it reprinted under every capability — the exact repetition being removed.
  const html = renderToStaticMarkup(
    BaseMcpExtensionsCard({
      enabled: true,
      loading: false,
      status: 'connected',
      unavailableReason: null,
      tools: [
        { name: 'get_portfolio', capability: 'read_only', scope: 'wallet' },
        { name: 'chain_rpc_request', capability: 'read_only', scope: 'protocol' },
        { name: 'send', capability: 'user_confirmed_transaction', scope: 'wallet' },
      ],
    }),
  );
  assert.equal((html.match(/The word beside each tool is what it touches/g) ?? []).length, 1);
  // Two capability groups, both folded shut.
  assert.equal((html.match(/<details class="mcp-group">/g) ?? []).length, 2);
  assert.ok(!/<details class="mcp-group" open/.test(html));
});

