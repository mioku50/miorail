import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import type { AaveCollateralV1, MirrorReport } from '@mioagent/still-engine';
import { ADDRESSES, CRYPTO } from '@mioagent/still-engine/registry';

import type { StillLoanCallClientV1 } from './stillLoanHolds.js';
import { readStillPaxgWeekendPriceV1, stillLoanWeekendShadowsV1, stillWeekendLadderPricesV1 } from './stillLoanWeekend.js';

// The weekend of Nov 20: the window opens Friday 20:00 New York time and closes Sunday 20:00.
const OPENS = '2026-11-21T01:00:00.000Z';
const ENDS = '2026-11-23T01:00:00.000Z';
const NOW = new Date('2026-11-21T15:00:00.000Z');
/** The feed's last print, Friday afternoon, before the window. */
const FRIDAY = '2026-11-20T20:55:00.000Z';
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 21, hour, minute)).toISOString();
const NVDA = '0x00000000000000000000000000000000000000a1';
const AAPL = '0x00000000000000000000000000000000000000a2';
const PAXG = CRYPTO.find((asset) => asset.id === 'PAXG')!;
const WAD = 10n ** 18n;

const mid = (token: string, when: string, ratio: number, over: Record<string, unknown> = {}) =>
  ({ token, at: when, mid: 100 * ratio, reference: 100, referenceUpdatedAt: FRIDAY, ...over });

describe('a stock\'s price on Base while its feed holds', () => {
  test('the latest two readings half an hour apart, and of those the one nearer the feed', () => {
    const prices = stillWeekendLadderPricesV1({
      mids: [mid(NVDA, at(14, 40), 0.96), mid(NVDA, at(14, 20), 0.90), mid(NVDA, at(14, 0), 0.95), mid(AAPL.toUpperCase().replace('0X', '0x'), at(14, 30), 0.98)],
      windowStartsAt: OPENS, now: NOW,
    });
    // 14:20 is too close to 14:40 to be a second opinion; 14:00 is, and 14:40 is nearer the feed of the two.
    assert.deepEqual(Object.fromEntries(prices), { [NVDA]: { ratio: 0.96, at: at(14, 40) } }, 'one reading alone never counts');
    // Audit P2-4, 2026-11-18: readings on opposite sides of the feed confirm no move, so the stock counts at the
    // feed's price. At 100, 82 then 125 the owner was told of an 18% fall while the last price stood 25% above.
    for (const [first, last] of [[0.95, 1.02], [0.82, 1.25], [1.1, 0.9], [1, 0.9]] as const) {
      const opposite = stillWeekendLadderPricesV1({ mids: [mid(NVDA, at(14, 40), last), mid(NVDA, at(14, 0), first)], windowStartsAt: OPENS, now: NOW });
      assert.equal(opposite.get(NVDA), undefined, `${first} then ${last}`);
    }
    // Two that agree still give the milder of them, with its time.
    const agreeing = stillWeekendLadderPricesV1({ mids: [mid(NVDA, at(14, 40), 0.82), mid(NVDA, at(14, 0), 0.85)], windowStartsAt: OPENS, now: NOW });
    assert.deepEqual(agreeing.get(NVDA), { ratio: 0.85, at: at(14, 0) });
  });

  test('a reading before the window, older than four hours, beside a feed that printed since it opened, or broken, does not count', () => {
    const prices = stillWeekendLadderPricesV1({
      mids: [
        mid(NVDA, '2026-11-21T00:30:00.000Z', 0.9), mid(NVDA, at(10, 30), 0.9),
        mid(NVDA, at(14, 40), 0.9, { referenceUpdatedAt: at(12) }), mid(NVDA, at(14, 0), 0.9, { referenceUpdatedAt: at(12) }),
        mid(AAPL, at(14, 40), 0.3), mid(AAPL, at(14, 0), 0.3),
        mid(AAPL, at(13, 40), 0.97, { reference: 0 }),
      ],
      windowStartsAt: OPENS, now: NOW,
    });
    assert.deepEqual(Object.fromEntries(prices), {});
  });
});

function stockLine(symbol: string, token: string, over: Record<string, unknown> = {}) {
  return { asset: symbol, kind: 'stock', symbol, token, venue: 'aave-v4', pledged: { raw: '100000000', decimals: 8 },
    priceCents: '18000', priceUpdatedAt: FRIDAY, protocolFactorBps: 7_000, limits: [], failed: [], ...over };
}

/** What the reading's own Aave position pledges, as still-engine's aaveCollateralOfV1 gives it: equal weights unless said. */
const pledges = (...rows: [asset: string, token: string, weight?: bigint][]): AaveCollateralV1[] =>
  rows.map(([asset, token, weight = 1_000n]) => ({ asset: asset as AaveCollateralV1['asset'], token: token as Address, weight }));

function aaveLine(healthFactor = 2n * WAD, over: Record<string, unknown> = {}) {
  return { venue: 'aave-v4', market: ADDRESSES.aaveSpoke, debtAtomic: '1000000000',
    safety: { healthFactor: healthFactor.toString(), marginBps: 5_000, state: 'calm', source: 'protocol' }, ...over };
}

function weekendReport(venues: unknown[], assets: unknown[], active = true): MirrorReport {
  return {
    reading: { block: '58500000', blockTime: NOW.toISOString() },
    terms: { weekend: { active, startsAt: OPENS, endsAt: ENDS, stockShareBps: 4_000 } },
    venues, assets,
  } as unknown as MirrorReport;
}

describe('a loan at the price its collateral trades at', () => {
  test('one stock: the health factor read, times its move, in the band that gives', () => {
    const [shadow, ...rest] = stillLoanWeekendShadowsV1({
      report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA)]),
      aaveCollateral: pledges(['NVDAc', NVDA]),
      stocks: new Map([[NVDA, { ratio: 0.7, at: at(14) }]]),
    });
    assert.equal(rest.length, 0);
    // 2.0 × 0.7 = 1.4: the collateral could fall 1 - 1/1.4 = 28.57%, rounded down.
    assert.deepEqual({ ...shadow, movers: shadow!.movers }, {
      market: ADDRESSES.aaveSpoke.toLowerCase(), venue: 'aave-v4', oracleState: 'calm', oracleMarginBps: 5_000, state: 'watch', marginBps: 2_857,
      movers: [{ symbol: 'NVDAc', ratio: 0.7 }], source: 'onchain', heldSince: FRIDAY, windowStartsAt: OPENS, windowEndsAt: ENDS, debtAtomic: '1000000000',
    });
  });

  test('several stocks weigh by what each pledged is worth to the venue; one not measured counts at the oracle\'s price', () => {
    const [shadow] = stillLoanWeekendShadowsV1({
      report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA), stockLine('AAPLc', AAPL)]),
      aaveCollateral: pledges(['NVDAc', NVDA], ['AAPLc', AAPL]),
      stocks: new Map([[NVDA, { ratio: 0.5, at: at(14) }]]),
    });
    // (0.5 + 1) / 2 of 2.0 is 1.5: a margin of 33.33%.
    assert.deepEqual([shadow!.state, shadow!.marginBps, shadow!.movers.map((row) => row.symbol)], ['watch', 3_333, ['NVDAc']]);
    // The position's own weights, not equal shares: NVDAc weighs three times AAPLc, so (3 × 0.5 + 1) / 4 of 2.0 is 1.25.
    const [weighed] = stillLoanWeekendShadowsV1({
      report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA), stockLine('AAPLc', AAPL)]),
      aaveCollateral: pledges(['NVDAc', NVDA, 3_000n], ['AAPLc', AAPL, 1_000n]),
      stocks: new Map([[NVDA, { ratio: 0.5, at: at(14) }]]),
    });
    assert.deepEqual([weighed!.state, weighed!.marginBps], ['watch', 2_000]);
    // A stock whose feed printed since the window opened is not held: it counts at the oracle's price, so nothing is measured.
    assert.deepEqual(stillLoanWeekendShadowsV1({
      report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA, { priceUpdatedAt: at(12) })]),
      aaveCollateral: pledges(['NVDAc', NVDA]),
      stocks: new Map([[NVDA, { ratio: 0.5, at: at(14) }]]),
    }), []);
  });

  test('a stock supplied but not pledged weighs nothing, either way (audit ALERT-1)', () => {
    const report = weekendReport([aaveLine()], [stockLine('NVDAc', NVDA), stockLine('AAPLc', AAPL)]);
    // NVDAc is the collateral and falls by half; AAPLc is only supplied. Weighing both said a 33% margin; the
    // position can be liquidated at that price.
    const [diluted] = stillLoanWeekendShadowsV1({ report, aaveCollateral: pledges(['NVDAc', NVDA]), stocks: new Map([[NVDA, { ratio: 0.5, at: at(14) }]]) });
    assert.deepEqual([diluted!.state, diluted!.marginBps], ['liquidation', 0]);
    // AAPLc falls by half but is not collateral: nothing the loan stands on moved, so there is nothing to say.
    assert.deepEqual(stillLoanWeekendShadowsV1({ report, aaveCollateral: pledges(['NVDAc', NVDA]), stocks: new Map([[AAPL, { ratio: 0.5, at: at(14) }]]) }), []);
    // USDC pledged beside the stock counts at its own price.
    const [beside] = stillLoanWeekendShadowsV1({ report, aaveCollateral: pledges(['NVDAc', NVDA], [null as unknown as string, ADDRESSES.usdc]),
      stocks: new Map([[NVDA, { ratio: 0.5, at: at(14) }]]) });
    assert.deepEqual([beside!.marginBps, beside!.movers.map((row) => row.symbol)], [3_333, ['NVDAc']]);
  });

  test('nothing outside the window, for a loan with no debt, with no price measured, or with its collateral not all read', () => {
    const stocks = new Map([[NVDA, { ratio: 0.5, at: at(14) }]]);
    const aaveCollateral = pledges(['NVDAc', NVDA]);
    assert.deepEqual(stillLoanWeekendShadowsV1({ report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA)], false), aaveCollateral, stocks }), []);
    assert.deepEqual(stillLoanWeekendShadowsV1({ report: weekendReport([aaveLine(2n * WAD, { debtAtomic: '0' })], [stockLine('NVDAc', NVDA)]), aaveCollateral, stocks }), []);
    assert.deepEqual(stillLoanWeekendShadowsV1({ report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA)]), aaveCollateral, stocks: new Map() }), []);
    assert.deepEqual(stillLoanWeekendShadowsV1({ report: weekendReport([aaveLine()], [stockLine('NVDAc', NVDA)]), aaveCollateral: null, stocks }), []);
  });

  test('PAXG on Morpho at its own feed against the gold Morpho holds', () => {
    const morpho = { venue: 'morpho', market: PAXG.morphoMarket, debtAtomic: '40000000',
      safety: { healthFactor: (15n * WAD / 10n).toString(), marginBps: 3_333, state: 'watch', source: 'computed' } };
    const paxg = { asset: 'PAXG', kind: 'crypto', symbol: 'PAXG', token: PAXG.token, venue: 'morpho', pledged: { raw: '20000000000000000', decimals: 18 },
      priceCents: '388101', priceUpdatedAt: FRIDAY, protocolFactorBps: 7_700, limits: [], failed: [] };
    const [shadow] = stillLoanWeekendShadowsV1({ report: weekendReport([morpho], [paxg]), aaveCollateral: null, stocks: new Map(), paxg: { ratio: 0.9, at: at(14) } });
    // 1.5 × 0.9 = 1.35: 25.92%.
    assert.deepEqual([shadow!.source, shadow!.state, shadow!.marginBps, shadow!.oracleState, shadow!.movers], ['paxg_feed', 'watch', 2_592, 'watch', [{ symbol: 'PAXG', ratio: 0.9 }]]);
  });
});

const ORACLE_ABI = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function currentOracle() view returns (address)',
  'function primaryOracle() view returns (address)',
  'function backupOracle() view returns (address)',
  'function price() view returns (uint256)',
]);
const META = '0x6a47f48780eaeb07ee18ca47a9c33c925961bfad' as Address;
const GOLD = '0x8e67ef9a3ec79839c6602f1259a2567954695125' as Address;
const PAXG_FEED = '0xc2164af8ab5a3cddc0b7c6a35c1aa7e2aa289a26' as Address;

/** Answers Morpho's market params and Multicall3's batches the way the PAXG market's meta-oracle does. */
function oracleClient(options: { current?: Address; seen?: string[] } = {}): StillLoanCallClientV1 {
  const answer = (target: string, callData: Hex): Hex => {
    const { functionName } = decodeFunctionData({ abi: ORACLE_ABI, data: callData });
    if (target === META && functionName === 'currentOracle') return encodeFunctionResult({ abi: ORACLE_ABI, functionName, result: options.current ?? GOLD });
    if (target === META && functionName === 'primaryOracle') return encodeFunctionResult({ abi: ORACLE_ABI, functionName, result: GOLD });
    if (target === META && functionName === 'backupOracle') return encodeFunctionResult({ abi: ORACLE_ABI, functionName, result: PAXG_FEED });
    // The prices Base gave on 2026-11-17: gold 3,881.01, PAXG 3,859.25.
    if (target === GOLD && functionName === 'price') return encodeFunctionResult({ abi: ORACLE_ABI, functionName, result: 3_881_010_000_000_000_000_000_000_000n });
    if (target === PAXG_FEED && functionName === 'price') return encodeFunctionResult({ abi: ORACLE_ABI, functionName, result: 3_859_249_798_690_000_000_000_000_000n });
    throw new Error(`unexpected ${functionName} on ${target}`);
  };
  return {
    async call({ to, data }: { to: Address; data: Hex; blockNumber: bigint }) {
      options.seen?.push(to.toLowerCase());
      const { functionName, args } = decodeFunctionData({ abi: ORACLE_ABI, data });
      if (to.toLowerCase() === ADDRESSES.morpho.toLowerCase() && functionName === 'idToMarketParams') {
        return { data: encodeFunctionResult({ abi: ORACLE_ABI, functionName, result: [ADDRESSES.usdc as Address, PAXG.token as Address, META, META, 770_000_000_000_000_000n] }) };
      }
      const calls = (args as unknown as [readonly { target: Address; callData: Hex }[]])[0];
      return { data: encodeFunctionResult({ abi: ORACLE_ABI, functionName: 'aggregate3',
        result: calls.map((call) => ({ success: true, returnData: answer(call.target.toLowerCase(), call.callData) })) }) };
    },
  };
}

describe('PAXG against the gold its Morpho market holds', () => {
  const owed = weekendReport([{ venue: 'morpho', market: PAXG.morphoMarket, debtAtomic: '40000000' }], []);

  test('the meta-oracle\'s backup, PAXG/USD, over the gold oracle it reads now, at the reading\'s block', async () => {
    const seen: string[] = [];
    const price = await readStillPaxgWeekendPriceV1({ clients: [oracleClient({ seen })], report: owed });
    assert.ok(price && Math.abs(price.ratio - 0.994393) < 1e-6, `ratio ${price?.ratio}`);
    assert.equal(price!.at, NOW.toISOString());
    assert.deepEqual(seen, [ADDRESSES.morpho.toLowerCase(), ADDRESSES.multicall3.toLowerCase(), ADDRESSES.multicall3.toLowerCase()]);
  });

  test('nothing when Morpho already reads PAXG/USD, outside the window, or without a PAXG debt', async () => {
    assert.equal(await readStillPaxgWeekendPriceV1({ clients: [oracleClient({ current: PAXG_FEED })], report: owed }), null);
    const seen: string[] = [];
    assert.equal(await readStillPaxgWeekendPriceV1({ clients: [oracleClient({ seen })],
      report: weekendReport([{ venue: 'morpho', market: PAXG.morphoMarket, debtAtomic: '40000000' }], [], false) }), null);
    assert.equal(await readStillPaxgWeekendPriceV1({ clients: [oracleClient({ seen })],
      report: weekendReport([{ venue: 'morpho', market: PAXG.morphoMarket, debtAtomic: '0' }], []) }), null);
    assert.deepEqual(seen, [], 'not asked');
    assert.equal(await readStillPaxgWeekendPriceV1({ clients: [{ call: async () => { throw new Error('down'); } }], report: owed }), null);
  });
});
