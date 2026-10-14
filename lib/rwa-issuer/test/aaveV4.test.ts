import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aaveV4DefiSourceV1, aaveV4ListingV1, readAaveV4PositionV1, readAaveV4ReservesV1,
  AaveV4PositionV1Schema, AAVE_V4_BASE_USDC_V1,
} from '../src/aaveV4.js';
import { reservesFixtureV1, positionFixtureV1, STOCK, USER, SPOKE_ID } from './fixtures/aaveV4.js';

function transport(reserves = reservesFixtureV1(), position: unknown = positionFixtureV1()) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.v4.aave.com/graphql');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    const request = JSON.parse(String(init?.body)); calls.push(request);
    return Response.json({ data: request.query.includes('userPosition(') ? { userPosition: position } : { reserves } });
  };
  return { calls, fetchImpl };
}

test('V4 exact stock address establishes collateral, not stock lending or borrowing; fractions become bps once', async () => {
  const t = transport();
  const reserves = await readAaveV4ReservesV1(t);
  const row = aaveV4ListingV1(STOCK.toUpperCase().replace('0X','0x'), reserves);
  assert.equal(row.state, 'listed');
  assert.deepEqual(row.uses, { lend: false, borrow: false, collateral: true });
  const market = row.markets![0]!;
  assert.equal(market.lltvBps, null);
  assert.equal(market.aaveV4?.collateralFactorBps, 7000);
  assert.equal(market.borrowApyBps, 235);
  assert.equal(market.supplyApyBps, 123);
  assert.equal(market.collateralUsd, 22000);
  assert.equal(market.liquidityUsd, 75);
  assert.equal(t.calls.length, 1);
  assert.equal(aaveV4ListingV1(USER, reserves).state, 'not_listed', 'a matching symbol elsewhere must not establish identity');
  assert.equal(aaveV4ListingV1(AAVE_V4_BASE_USDC_V1, reserves).uses.borrow, true);
});

test('paused collateral remains listed but cannot become a positive current-use claim; blocked USDC is not available to borrow', async () => {
  const rows = reservesFixtureV1(); rows[0]!.status.paused = true; rows[0]!.canUseAsCollateral = false; rows[1]!.status.frozen = true;
  const parsed = await readAaveV4ReservesV1(transport(rows));
  const row = aaveV4ListingV1(STOCK, parsed);
  assert.equal(row.state, 'listed'); assert.equal(row.uses.collateral, false);
  assert.equal(row.markets![0]!.role, 'collateral', 'a pause cannot turn a collateral reserve into a loan asset');
  assert.equal(row.markets![0]!.liquidityUsd, 0);
  assert.equal(row.markets![0]!.aaveV4!.loanBorrowableTokens, '75', 'the API figure and the blocked operation remain separate');
});

test('wrong chain, hub, spoke, duplicate addresses, incomplete USDC data and unknown schemas fail closed', async () => {
  const changes = [
    (r: ReturnType<typeof reservesFixtureV1>) => { r[0]!.chain.chainId = 1; },
    (r: ReturnType<typeof reservesFixtureV1>) => { r[0]!.asset.hub.address = USER; },
    (r: ReturnType<typeof reservesFixtureV1>) => { r[0]!.spoke.address = USER; },
    (r: ReturnType<typeof reservesFixtureV1>) => { r[1]!.asset.underlying.address = STOCK; },
    (r: ReturnType<typeof reservesFixtureV1>) => { r[0]!.summary.supplied.exchange.value = '-1'; },
  ];
  for (const change of changes) {
    const rows = reservesFixtureV1(); change(rows);
    const result = await aaveV4DefiSourceV1(transport(rows)).lookup(STOCK);
    assert.equal(result.state, 'unread'); assert.equal(result.uses.collateral, null);
    assert.equal(result.reason, 'aave_v4_read_unavailable');
  }
  assert.equal((await aaveV4DefiSourceV1(transport(reservesFixtureV1().slice(0,1))).lookup(STOCK)).state, 'unread');
});

test('HTTP errors, partial GraphQL errors and oversized bodies do not mean not listed', async () => {
  for (const response of [new Response('', { status: 503 }), Response.json({ data: { reserves: reservesFixtureV1() }, errors: [{ message: 'private URL' }] }), new Response(' '.repeat(256001)), Response.json({ data: {} })]) {
    const row = await aaveV4DefiSourceV1({ fetchImpl: async () => response }).lookup(STOCK);
    assert.equal(row.state, 'unread'); assert.doesNotMatch(JSON.stringify(row), /private URL/);
  }
});

test('position reads use the returned opaque spoke id and the exact requested wallet; amounts and net interest retain precision', async () => {
  const t = transport();
  const row = await readAaveV4PositionV1(USER, { ...t, clock: () => new Date('2026-10-14T12:00:00Z') });
  assert.equal(t.calls.length, 2); assert.deepEqual(t.calls[1]!.variables, { user: USER, spoke: SPOKE_ID });
  assert.equal(row.walletAddress, USER); assert.equal(row.debtUsd, '500');
  assert.equal(row.netAccruedInterestUsd, '-0.125'); assert.equal(row.healthFactor, '2.8');
  assert.equal(row.netBorrowApyBps, 333); assert.equal(row.source, 'aave_api');
  assert.equal(AaveV4PositionV1Schema.safeParse(row).success, true);
  assert.equal(AaveV4PositionV1Schema.safeParse({ ...row, state: 'empty' }).success, false);
  const negative = positionFixtureV1(); negative.netBorrowApy.current.value = '-0.001';
  assert.equal((await readAaveV4PositionV1(USER, transport(undefined, negative))).netBorrowApyBps, -10);
});

test('empty position is scoped to MAG7, failures and missing health with debt are not an empty position', async () => {
  const empty = await readAaveV4PositionV1(USER, transport(undefined, null));
  assert.equal(empty.state, 'empty'); assert.equal(empty.debtUsd, null);
  const other = { ...positionFixtureV1(), user: STOCK };
  await assert.rejects(() => readAaveV4PositionV1(USER, transport(undefined, other)), /identity_invalid/);
  await assert.rejects(() => readAaveV4PositionV1(USER, transport(undefined, { ...positionFixtureV1(), healthFactor: { current: null } })), /health_unread/);
  await assert.rejects(() => readAaveV4PositionV1(USER, transport(undefined, {})));
});
