import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { STILL_BOARD_QUERY_PARAMS_V1, stillHomeRedirectV1 } from './homeQuery';

const NVDA = '?key=security%3Aisin%3AUS67066G1040';

// Audit P3 Home query, 2026-11-18: any query at all sent "/" to the board, so a
// guest who followed `/?utm_source=base` landed on Stocks instead of Home.
test('a campaign tag alone opens Home, for a guest and for a session', () => {
  for (const signedIn of [false, true]) {
    assert.equal(stillHomeRedirectV1('?utm_source=base', signedIn), null);
    assert.equal(stillHomeRedirectV1('?utm_source=base&utm_medium=social&utm_campaign=launch', signedIn), null);
    assert.equal(stillHomeRedirectV1('', signedIn), null);
  }
});

test('a stock link still lands on the board, with its query as it was written', () => {
  assert.equal(stillHomeRedirectV1(NVDA, false), `/stocks${NVDA}`);
  assert.equal(stillHomeRedirectV1(NVDA, true), `/market${NVDA}`);
  assert.equal(stillHomeRedirectV1('?key=security%3Aisin%3AUS67066G1040&direction=buy&size=10000000000', false),
    '/stocks?key=security%3Aisin%3AUS67066G1040&direction=buy&size=10000000000');
});

test('a campaign tag beside a board parameter is still a stock link, and keeps both', () => {
  assert.equal(stillHomeRedirectV1(`${NVDA}&utm_source=base`, false), `/stocks${NVDA}&utm_source=base`);
  assert.equal(stillHomeRedirectV1('?utm_source=base&weekend=2026-11-21', true), '/market?utm_source=base&weekend=2026-11-21');
});

test('every parameter the board reads is one "/" hands on', () => {
  for (const name of STILL_BOARD_QUERY_PARAMS_V1) {
    assert.equal(stillHomeRedirectV1(`?${name}=x`, false), `/stocks?${name}=x`, name);
  }
});

test('the list is the names the board actually reads, so the two cannot drift apart', () => {
  const page = readFileSync(fileURLToPath(new URL('../rwa/MarketRealityPage.tsx', import.meta.url)), 'utf8');
  const read = new Set([...page.matchAll(/\.(?:get|has|getAll)\('([A-Za-z_][\w-]*)'\)/g)].map((match) => match[1]!));
  assert.deepEqual([...read].sort(), [...STILL_BOARD_QUERY_PARAMS_V1].sort());
});
