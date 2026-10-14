import assert from 'node:assert/strict';
import test from 'node:test';
import { aaveV4DefiSourceV1 } from '@mioagent/rwa-issuer/aaveV4';
import { RepresentationUseAccessV1Schema, defiListingV1 } from '@mioagent/rwa-issuer/useAccess';
import { useAccessForAgentV1, UseAccessAgentOutputV1Schema } from '@mioagent/rwa-issuer/useAccessAgent';
import { reservesFixtureV1, STOCK } from '../../rwa-issuer/test/fixtures/aaveV4.js';
import { useSectionsV1 } from '../src/console/marketRealityView';
import { stockUsesViewV1 } from '../src/console/stockUsesView';

test('one V4 reading survives strict web and MCP schemas and fixes the compact and detailed stock cards', async () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const source = aaveV4DefiSourceV1({ fetchImpl: async () => Response.json({ data: { reserves: reservesFixtureV1() } }) });
  const use = RepresentationUseAccessV1Schema.parse({
    schemaVersion: 'representation-use-access/v1', chainId: 8453, tokenAddress: STOCK,
    caip10: `eip155:8453:${STOCK}`, blockTag: '0x1', observedAt: now.toISOString(),
    transfers: { state: 'read', transfersPaused: false }, transferPolicies: [], bridge: { state: 'none_detected' },
    defi: await defiListingV1(STOCK, [source], () => now), wallet: null,
  });
  const agent = UseAccessAgentOutputV1Schema.parse(useAccessForAgentV1({ use, underlyingKey: 'test-nvda', displaySymbol: 'NVDA', issuerId: 'coinbase' }));
  assert.equal(agent.defi.venues[0]!.markets![0]!.aaveV4?.collateralFactorBps, 7000);
  assert.equal(agent.defi.venues[0]!.observed?.source, 'venue_catalogue');
  assert.equal(agent.announcements[0]!.measured, 'listed');
  const section = useSectionsV1({ use, issuerId: 'coinbase', groups: [], exit: null, exitBasis: null,
    openQuote: null, lastMeasuredLabel: null, outcomeBody: '', caip10: use.caip10 }).find(s => s.id === 'defi')!;
  assert.match(section.headline, /Collateral at Aave v4 Equities/);
  assert.equal(section.facts.find(f => f.label === 'Aave v4 collateral factor')?.value, '70%');
  assert.match(section.facts.find(f => f.label === 'USDC variable rates')!.value, /Borrow 2.35% APY/);
  assert.match(section.facts.find(f => f.label === 'USDC borrowing')!.note!, /not your borrowing power/);
  assert.doesNotMatch(JSON.stringify(section), /Not there yet|not live yet|70% LLTV/);
  const compact = stockUsesViewV1({ use, tokenSymbol: 'NVDAc', priceUsd: null, now })!;
  assert.equal(compact.rows[0]!.id, 'aave-borrow');
  assert.match(compact.rows[0]!.text, /70% collateral factor.*2.35% base variable APY/);
  assert.match(compact.rows[0]!.text, /not your borrowing power/);
  assert.match(compact.rows[0]!.href!, /^https:\/\/pro.aave.com\/explore\/hub\//);
});

test('V4 corporate-action pause stays visible as a restriction, not a current collateral permission', async () => {
  const reserves = reservesFixtureV1(); reserves[0]!.status.paused = true;
  const source = aaveV4DefiSourceV1({ fetchImpl: async () => Response.json({ data: { reserves } }) });
  const listing = await source.lookup(STOCK);
  const use = { schemaVersion: 'representation-use-access/v1' as const, chainId: 8453 as const, tokenAddress: STOCK,
    caip10: `eip155:8453:${STOCK}`, blockTag: null, observedAt: '2026-10-14T12:00:00Z',
    transfers: { state: 'read' as const, transfersPaused: false }, transferPolicies: [], bridge: { state: 'none_detected' as const },
    defi: { checkedVenues: [source.venueName], venues: [listing] }, wallet: null };
  const view = stockUsesViewV1({ use, tokenSymbol: 'NVDAc', priceUsd: null, now: new Date(use.observedAt) })!;
  assert.match(view.rows[0]!.text, /Adding collateral paused/);
  assert.equal(listing.uses.collateral, false);
  const section = useSectionsV1({ use, issuerId: 'coinbase', groups: [], exit: null, exitBasis: null,
    openQuote: null, lastMeasuredLabel: null, outcomeBody: '', caip10: use.caip10 }).find(s => s.id === 'defi')!;
  assert.match(section.headline, /names a market for this exact address/);
  assert.doesNotMatch(section.headline, /No reviewed lending venue lists/);
  assert.equal(section.facts.find(f => f.label === 'Adding this asset')!.value, 'Paused');
});
