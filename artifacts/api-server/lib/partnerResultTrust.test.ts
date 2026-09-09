import assert from 'node:assert/strict';
import test from 'node:test';
import { screenPartnerToolResult } from './partnerResultTrust.js';

const canonicalUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function market(overrides: Record<string, unknown> = {}) {
  return {
    id: `0x${'1'.repeat(64)}`,
    loanAsset: { address: canonicalUsdc, symbol: 'USDC' },
    collateralAsset: { address: '0x2222222222222222222222222222222222222222', symbol: 'WETH' },
    verified: true,
    supplyApyPct: 5.2,
    borrowApyPct: 7.1,
    supplyAssetsUsd: 25_000_000,
    liquidityAssetsUsd: 5_000_000,
    lltvPct: 86,
    utilizationPct: 80,
    ...overrides,
  };
}

test('Morpho market screening removes extreme APY, test assets, tiny liquidity, and unverified records', () => {
  const payload = {
    chain: 'base',
    markets: [
      market(),
      market({ id: `0x${'2'.repeat(64)}`, supplyApyPct: 297_995, borrowApyPct: 297_995 }),
      market({
        id: `0x${'3'.repeat(64)}`,
        collateralAsset: { address: '0x3333333333333333333333333333333333333333', symbol: 'TEST-SPAM' },
      }),
      market({ id: `0x${'4'.repeat(64)}`, liquidityAssetsUsd: 1 }),
      market({ id: `0x${'5'.repeat(64)}`, verified: false }),
    ],
  };

  const result = screenPartnerToolResult({
    toolName: 'morpho_query_markets',
    content: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    isError: false,
    providerNamespace: 'morpho',
  });

  assert.equal(result.isError, false);
  const screened = JSON.parse(result.content);
  assert.equal(screened.markets.length, 1);
  assert.equal(screened.markets[0].id, `0x${'1'.repeat(64)}`);
  assert.equal(screened.screening.recommendation, false);
  assert.doesNotMatch(result.content, /297995|TEST-SPAM/);
});

test('Morpho market screening fails closed when no trustworthy result remains', () => {
  const result = screenPartnerToolResult({
    toolName: 'morpho_query_markets',
    content: JSON.stringify({ chain: 'base', markets: [market({ verified: false, supplyApyPct: 999_999 })] }),
    isError: false,
    providerNamespace: 'morpho',
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content), { errorCode: 'morpho_no_trustworthy_markets' });
  assert.doesNotMatch(result.content, /999999/);
});

test('partners without a provider-specific screener fail closed without raw data', () => {
  const result = screenPartnerToolResult({
    toolName: 'unknown_query_markets',
    content: '{"secretMarket":"unscreened raw opportunity"}',
    isError: false,
    providerNamespace: 'unknown',
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content), { errorCode: 'unknown_result_screening_unavailable' });
  assert.doesNotMatch(result.content, /unscreened raw opportunity/);
});

// ---------------------------------------------------------------------------
// A payload that reports its own failure.
//
// Morpho answered `{"error":"NOT_FOUND","message":"Unknown tool: …"}` with the
// MCP error flag clear. The screener's fallthrough wrapped it as a screened
// read, and the chat printed "Live screened Morpho read result on Base" above
// the words "Unknown tool" — a reader told a provider had answered about their
// money when it had refused to answer at all.
// ---------------------------------------------------------------------------

test('an error inside a successful-looking payload is an error', () => {
  const result = screenPartnerToolResult({
    toolName: 'morpho_get_positions',
    content: JSON.stringify({ error: 'NOT_FOUND', message: 'Unknown tool: morpho_get_positions' }),
    isError: false,
    providerNamespace: 'morpho',
  });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content), { errorCode: 'morpho_provider_reported_error' });
  assert.doesNotMatch(result.content, /Unknown tool/);
});

test('success: false is a failure even with no error field', () => {
  const result = screenPartnerToolResult({
    toolName: 'morpho_query_vaults',
    content: JSON.stringify({ success: false, vaults: [] }),
    isError: false,
    providerNamespace: 'morpho',
  });
  assert.equal(result.isError, true);
});

test('a record that merely carries a field named error is still data', () => {
  // Narrow on purpose: rejecting a whole read because one nested record has a
  // key called `error` would make this guard the second failure.
  const result = screenPartnerToolResult({
    toolName: 'morpho_query_vaults',
    content: JSON.stringify({ chain: 'base', vaults: [{ ...market(), error: null }] }),
    isError: false,
    providerNamespace: 'morpho',
  });
  assert.notEqual(JSON.parse(result.content).errorCode, 'morpho_provider_reported_error');
});
