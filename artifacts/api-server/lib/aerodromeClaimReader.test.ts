import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult, type Abi } from 'viem';
import {
  AERODROME_SUGAR_V1, AERODROME_VOTER_V1, AERODROME_BASIC_FACTORY_V1,
  AERODROME_CL_FACTORIES_V1, AERODROME_CL_NFPMS_V1, AERODROME_AERO_V1, AERODROME_CLAIM_ABI_V1,
  AERODROME_BATCH_CALLS_V1, SUGAR_MAX_ITERATIONS_V1, readAerodromeClaimPlanV1,
  type AerodromeClaimCallV1, type AerodromeClaimReadV1, type AerodromeSugarPositionV1,
} from './aerodromeClaimReader.js';

export const WALLET = '0x1111111111111111111111111111111111111111';
export const POOL = '0x2222222222222222222222222222222222222222';
export const CL_POOL = '0x3333333333333333333333333333333333333333';
export const GAUGE = '0x4444444444444444444444444444444444444444';
export const CL_GAUGE = '0x5555555555555555555555555555555555555555';
export const MANAGER = '0x6666666666666666666666666666666666666666';
const TOKEN0 = '0x7777777777777777777777777777777777777777';
const TOKEN1 = '0x8888888888888888888888888888888888888888';
const REGISTRY = '0x9999999999999999999999999999999999999999';
const ZERO = '0x0000000000000000000000000000000000000000';
const CL_FACTORY = AERODROME_CL_FACTORIES_V1[1];
const NFPM = AERODROME_CL_NFPMS_V1[CL_FACTORY];
/** The basic factory's pool at `index`, as allPools() answers in the fixture. */
export function basicPool(index: number): string {
  return `0xab${index.toString(16).padStart(38, '0')}`;
}
const isBasicPool = (target: string) => target === POOL || target.startsWith('0xab');
export function position(overrides: Partial<AerodromeSugarPositionV1> = {}): AerodromeSugarPositionV1 {
  return { id: 0n, lp: POOL, liquidity: 0n, staked: 0n, unstaked_earned0: 10n,
    unstaked_earned1: 0n, emissions_earned: 0n, alm: ZERO, locker: ZERO, ...overrides };
}
/** Answers the way Sugar does on Base: positions() carries basic and STAKED
 * concentrated rows; a wallet-held NFT comes only from the legacy call. */
export function fixtureReader(options: {
  rows?: AerodromeSugarPositionV1[]; count?: number; rowOffset?: number;
  held?: AerodromeSugarPositionV1[]; heldBalance?: number;
  override?: (target: string, name: string, args: readonly unknown[]) => unknown;
  page?: (limit: number, offset: number) => Promise<AerodromeSugarPositionV1[]>;
  /** Batched reads, answered call by call; each batch's size is recorded. */
  batches?: number[];
} = {}): AerodromeClaimReadV1 {
  const count = options.count ?? 500;
  const reader: AerodromeClaimReadV1 = { blockNumber: 100n, async read(target, name, args = []) {
    const replacement = options.override?.(target, name, args);
    if (replacement !== undefined) return replacement;
    if (target === AERODROME_SUGAR_V1 && name === 'count') return BigInt(count);
    if (target === AERODROME_SUGAR_V1 && name === 'registry') return REGISTRY;
    if (target === AERODROME_VOTER_V1 && name === 'factoryRegistry') return REGISTRY;
    if (target === REGISTRY && name === 'poolFactories') return [AERODROME_BASIC_FACTORY_V1, ...AERODROME_CL_FACTORIES_V1];
    if (name === 'allPoolsLength') return target === AERODROME_BASIC_FACTORY_V1 ? BigInt(count) : 0n;
    if (name === 'positions') {
      const [limit, offset] = args.map(Number);
      if (options.page) return options.page(limit, offset);
      const at = options.rowOffset ?? 0;
      return offset <= at && at < offset + limit ? options.rows ?? [position()] : [];
    }
    if (name === 'balanceOf') return target === NFPM ? BigInt(options.heldBalance ?? options.held?.length ?? 0) : 0n;
    if (name === 'allPools') return basicPool(Number(args[0]));
    if (['claimable0', 'claimable1', 'index0', 'index1', 'supplyIndex0', 'supplyIndex1', 'earned'].includes(name)) return 0n;
    if (name === 'positionsUnstakedConcentrated') return options.held ?? [];
    if (name === 'voter') return AERODROME_VOTER_V1;
    if (name === 'factory') return isBasicPool(target) ? AERODROME_BASIC_FACTORY_V1 : CL_FACTORY;
    if (name === 'isPool') return true;
    if (name === 'token0') return TOKEN0;
    if (name === 'token1') return TOKEN1;
    if (name === 'getPool') return CL_POOL;
    if (name === 'tickSpacing') return 100;
    if (name === 'nft') return NFPM;
    if (name === 'ownerOf') return args[0] === 42n ? CL_GAUGE : WALLET;
    if (name === 'gauges') return args[0] === POOL ? GAUGE : CL_GAUGE;
    if (name === 'gauge') return CL_GAUGE;
    if (name === 'pool') return CL_POOL;
    if (name === 'stakingToken') return POOL;
    if (name === 'rewardToken') return AERODROME_AERO_V1;
    if (name === 'stakedContains') return true;
    throw new Error(`unexpected fixture read: ${name}`);
  } };
  if (options.batches) {
    const batches = options.batches;
    reader.readMany = async (calls: readonly AerodromeClaimCallV1[]) => {
      batches.push(calls.length);
      const answers: unknown[] = [];
      for (const one of calls) answers.push(await reader.read(one.address, one.name, one.args));
      return answers;
    };
  }
  return reader;
}
const unstaked = position({ lp: CL_POOL, id: 41n, liquidity: 5n });

test('builds all four claims; the wallet-held NFT comes from the legacy call', async () => {
  const rows = [position({ emissions_earned: 5n, staked: 10n }),
    position({ lp: CL_POOL, id: 42n, staked: 10n, emissions_earned: 8n })];
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ rows, held: [unstaked] }), WALLET);
  assert.equal(plan.errorCode, null);
  assert.equal(plan.clPositionsTotal, 1); assert.equal(plan.clPositionsRead, 1);
  assert.deepEqual(plan.calls.map(item => item.kind), ['basic_fees', 'basic_aero', 'cl_aero', 'cl_fees']);
  assert.deepEqual(plan.calls.map(item => item.call.to), [POOL, GAUGE, CL_GAUGE, NFPM]);
  for (const item of plan.calls) assert.equal(item.call.valueWei, '0');
  const collect = decodeFunctionData({ abi: AERODROME_CLAIM_ABI_V1, data: plan.calls[3].call.data });
  assert.equal(collect.functionName, 'collect');
  const args = collect.args as any;
  assert.equal(args[0].recipient.toLowerCase(), WALLET);
  assert.equal(args[0].tokenId, 41n);
  assert.equal(args[0].amount0Max, (1n << 128n) - 1n);
  assert.equal(decodeFunctionData({ abi: AERODROME_CLAIM_ABI_V1, data: plan.calls[2].call.data }).args?.[0], 42n);
});
test('a wallet-held NFT that Sugar left out is unread, never "nothing to claim"', async () => {
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ held: [unstaked], heldBalance: 2 }), WALLET);
  assert.equal(plan.errorCode, 'aerodrome_incomplete_coverage');
  assert.equal(plan.clPositionsTotal, 2); assert.equal(plan.clPositionsRead, 1);
  assert.equal(plan.calls.length, 0);
});
test('more wallet-held NFTs than Sugar can return is refused', async () => {
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ held: [unstaked], heldBalance: 201 }), WALLET);
  assert.equal(plan.errorCode, 'aerodrome_positions_limit');
});
test('the legacy call is skipped when the wallet holds no NFT', async () => {
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ override: (_t, name) => {
    if (name === 'positionsUnstakedConcentrated') throw new Error('must not be read');
    return undefined;
  } }), WALLET);
  assert.equal(plan.errorCode, null); assert.equal(plan.clPositionsTotal, 0); assert.equal(plan.calls.length, 1);
});
test('the third approved CL factory and its manager are reviewed', async () => {
  const factory = AERODROME_CL_FACTORIES_V1[2];
  const nfpm = AERODROME_CL_NFPMS_V1[factory];
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ rows: [], held: [unstaked], override: (target, name) => {
    if (name === 'factory') return target === POOL ? AERODROME_BASIC_FACTORY_V1 : factory;
    if (name === 'nft') return nfpm;
    if (name === 'balanceOf') return target === nfpm ? 1n : 0n;
    return undefined;
  } }), WALLET);
  assert.equal(plan.errorCode, null);
  assert.deepEqual(plan.calls.map(item => [item.kind, item.call.to]), [['cl_fees', nfpm]]);
});
test('Sugar is never paged past its walk; the basic pools past it are read from the pools', async () => {
  let furthest = 0;
  const batches: number[] = [];
  const count = SUGAR_MAX_ITERATIONS_V1 + 500;
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ count, batches, page: async (limit, offset) => {
    furthest = Math.max(furthest, offset + limit); return [];
  } }), WALLET);
  assert.equal(furthest, SUGAR_MAX_ITERATIONS_V1);
  assert.equal(plan.errorCode, null);
  assert.equal(plan.poolsRead, count); assert.equal(plan.poolsReadDirect, 500); assert.equal(plan.poolsUnread, 0);
  assert.equal(plan.calls.length, 0);
  assert.ok(batches.length > 0 && batches.every(size => size <= AERODROME_BATCH_CALLS_V1));
});
test('a basic position past the walk is claimed like one Sugar returned, with the fees accrued since its index moved', async () => {
  const pool = basicPool(SUGAR_MAX_ITERATIONS_V1 + 123);
  const tailGauge = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
  const wad = 10n ** 18n;
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ count: SUGAR_MAX_ITERATIONS_V1 + 500, rows: [], batches: [],
    override: (target, name, args) => {
      if (target !== pool && target !== tailGauge && !(target === AERODROME_VOTER_V1 && args[0] === pool)) return undefined;
      if (name === 'gauges') return tailGauge;
      if (target === tailGauge) return { balanceOf: 3n, earned: 9n, rewardToken: AERODROME_AERO_V1, stakingToken: pool }[name];
      return { balanceOf: 7n * wad, claimable0: 5n, claimable1: 0n, index0: 3n * wad, supplyIndex0: wad,
        index1: wad, supplyIndex1: wad }[name];
    } }), WALLET);
  assert.equal(plan.errorCode, null);
  assert.equal(plan.positionsFound, 1);
  assert.deepEqual(plan.calls.map(item => [item.kind, item.call.to]), [['basic_fees', pool], ['basic_aero', tailGauge]]);
  // 5 stored, plus 7 LP × (3 − 1) per LP of fees accrued since the index moved.
  assert.equal(plan.calls[0].amount0, String(5n + 14n * wad)); assert.equal(plan.calls[0].amount1, '0');
  assert.equal(plan.calls[1].aero, '9');
});
test('a CL factory past the walk stays unread, and its pools are never listed', async () => {
  const listed: string[] = [];
  const clFactory = AERODROME_CL_FACTORIES_V1[0];
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ count: 500 + SUGAR_MAX_ITERATIONS_V1 + 10, override: (target, name) => {
    if (name === 'allPools') listed.push(target);
    if (name === 'allPoolsLength') return target === clFactory ? BigInt(SUGAR_MAX_ITERATIONS_V1 + 10) : target === AERODROME_BASIC_FACTORY_V1 ? 500n : 0n;
    return undefined;
  } }), WALLET);
  assert.equal(plan.errorCode, 'aerodrome_incomplete_coverage');
  assert.equal(plan.poolsUnread, 10); assert.equal(plan.poolsReadDirect, 0);
  assert.deepEqual(listed, []);
});
test('a direct read that fails, or a budget that ends before the pools do, is unread rather than empty', async () => {
  const count = SUGAR_MAX_ITERATIONS_V1 + 500;
  const failing = fixtureReader({ count, rows: [] });
  failing.readMany = async () => { throw new Error('multicall unavailable'); };
  const failed = await readAerodromeClaimPlanV1(failing, WALLET);
  assert.notEqual(failed.errorCode, null); assert.equal(failed.poolsUnread, 500); assert.equal(failed.calls.length, 0);
  const capped = await readAerodromeClaimPlanV1(fixtureReader({ count, rows: [] }), WALLET, { maxPools: SUGAR_MAX_ITERATIONS_V1 + 100 });
  assert.equal(capped.errorCode, 'aerodrome_incomplete_coverage');
  assert.equal(capped.poolsReadDirect, 100); assert.equal(capped.poolsUnread, 400);
});
test('an index behind the wallet’s own is unreadable, never a negative fee', async () => {
  const pool = basicPool(SUGAR_MAX_ITERATIONS_V1);
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ count: SUGAR_MAX_ITERATIONS_V1 + 1, rows: [],
    override: (target, name) => target !== pool ? undefined
      : ({ balanceOf: 1n, index0: 1n, supplyIndex0: 2n } as Record<string, bigint>)[name] }), WALLET);
  assert.equal(plan.errorCode, 'aerodrome_position_unreadable'); assert.equal(plan.poolsUnread, 1);
});
test('a catalogue the registry does not account for is unreadable', async () => {
  const short = await readAerodromeClaimPlanV1(fixtureReader({ override: (target, name) =>
    name === 'allPoolsLength' && target === AERODROME_BASIC_FACTORY_V1 ? 499n : undefined }), WALLET);
  assert.equal(short.errorCode, 'aerodrome_catalogue_unreadable');
  const foreign = await readAerodromeClaimPlanV1(fixtureReader({ override: (target, name) =>
    target === AERODROME_VOTER_V1 && name === 'factoryRegistry' ? TOKEN1 : undefined }), WALLET);
  assert.notEqual(foreign.errorCode, null);
});
test('reads count instead of SDK 9000 bound; empty pages do not stop it', async () => {
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ count: 10_000, rowOffset: 9_600 }), WALLET);
  assert.equal(plan.poolsRead, 10_000);
  assert.equal(plan.poolsUnread, 0);
  assert.equal(plan.calls.length, 1);
});
test('splits failed pages, with at most two requests in flight', async () => {
  let active = 0; let maxActive = 0;
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ count: 1_000, page: async (limit, offset) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (limit > 125) throw new Error('page unavailable');
    return offset === 875 ? [position()] : [];
  } }), WALLET);
  assert.equal(plan.poolsRead, 1_000); assert.equal(plan.poolsUnread, 0);
  assert.equal(plan.calls.length, 1); assert.ok(maxActive <= 2);
});
test('unread pages and capped catalogue cannot become no fees', async () => {
  const failed = await readAerodromeClaimPlanV1(fixtureReader({ page: async () => { throw new Error('offline'); } }), WALLET);
  assert.equal(failed.poolsUnread, 500); assert.equal(failed.errorCode, 'aerodrome_incomplete_coverage');
  const capped = await readAerodromeClaimPlanV1(fixtureReader({ count: 1_000 }), WALLET, { maxPools: 500 });
  assert.equal(capped.poolsUnread, 500); assert.equal(capped.errorCode, 'aerodrome_incomplete_coverage');
});
test('ALM and locker positions are explicitly excluded; duplicate rows do not duplicate calls', async () => {
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ rows: [position({ alm: MANAGER }),
    position({ locker: MANAGER }), position(), position()] }), WALLET);
  assert.equal(plan.managedSkipped, 2); assert.equal(plan.calls.length, 1);
});
test('a staked NFT’s fees go to voters; an unstaked one earning AERO is refused', async () => {
  const staked = await readAerodromeClaimPlanV1(fixtureReader({ rows: [position({ lp: CL_POOL, id: 42n, staked: 10n })] }), WALLET);
  assert.equal(staked.errorCode, null); assert.equal(staked.calls.length, 0);
  const contradiction = await readAerodromeClaimPlanV1(fixtureReader({ rows: [],
    held: [position({ lp: CL_POOL, id: 41n, emissions_earned: 3n })] }), WALLET);
  assert.equal(contradiction.errorCode, 'aerodrome_stake_owner_mismatch');
});
test('our Sugar ABI decodes the canonical sugar-sdk v0.4.0 shape field by field', () => {
  // sugar-sdk v0.4.0 `sugar/abis/sugar.json`, as published (names and order).
  const canonical = [{ type: 'function', name: 'positionsUnstakedConcentrated', stateMutability: 'view',
    inputs: [{ name: '_limit', type: 'uint256' }, { name: '_offset', type: 'uint256' }, { name: '_account', type: 'address' }],
    outputs: [{ name: '', type: 'tuple[]', components: [
      { name: 'id', type: 'uint256' }, { name: 'lp', type: 'address' }, { name: 'liquidity', type: 'uint256' },
      { name: 'staked', type: 'uint256' }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' },
      { name: 'staked0', type: 'uint256' }, { name: 'staked1', type: 'uint256' }, { name: 'unstaked_earned0', type: 'uint256' },
      { name: 'unstaked_earned1', type: 'uint256' }, { name: 'emissions_earned', type: 'uint256' }, { name: 'tick_lower', type: 'int24' },
      { name: 'tick_upper', type: 'int24' }, { name: 'sqrt_ratio_lower', type: 'uint160' }, { name: 'sqrt_ratio_upper', type: 'uint160' },
      { name: 'locker', type: 'address' }, { name: 'unlocks_at', type: 'uint32' }, { name: 'alm', type: 'address' },
    ] }] }] as const satisfies Abi;
  const row = { id: 77n, lp: CL_POOL, liquidity: 1n, staked: 0n, amount0: 2n, amount1: 3n, staked0: 0n, staked1: 0n,
    unstaked_earned0: 4n, unstaked_earned1: 5n, emissions_earned: 0n, tick_lower: -60, tick_upper: 60,
    sqrt_ratio_lower: 6n, sqrt_ratio_upper: 7n, locker: ZERO, unlocks_at: 0, alm: ZERO } as const;
  const data = encodeFunctionResult({ abi: canonical, functionName: 'positionsUnstakedConcentrated', result: [row] });
  for (const functionName of ['positionsUnstakedConcentrated', 'positions'] as const) {
    const [decoded] = decodeFunctionResult({ abi: AERODROME_CLAIM_ABI_V1, functionName, data }) as readonly Record<string, unknown>[];
    assert.equal(decoded.id, 77n); assert.equal(String(decoded.lp).toLowerCase(), CL_POOL);
    assert.equal(decoded.unstaked_earned0, 4n); assert.equal(decoded.unstaked_earned1, 5n);
    assert.equal(decoded.emissions_earned, 0n); assert.equal(String(decoded.alm).toLowerCase(), ZERO);
  }
});
for (const [label, target, name, replacement] of [
  ['foreign factory', POOL, 'factory', TOKEN1],
  ['spoofed registered pool', AERODROME_BASIC_FACTORY_V1, 'isPool', false],
  ['foreign Sugar voter', AERODROME_SUGAR_V1, 'voter', TOKEN1],
  ['foreign gauge', GAUGE, 'stakingToken', TOKEN1],
  ['foreign reward token', GAUGE, 'rewardToken', TOKEN1],
  ['foreign CL gauge', CL_POOL, 'gauge', TOKEN1],
  ['unowned NFT', NFPM, 'ownerOf', TOKEN1],
  ['foreign manager factory', NFPM, 'factory', TOKEN1],
  ['unreviewed position manager', CL_POOL, 'nft', MANAGER],
  ['unregistered CL pool', CL_FACTORY, 'getPool', TOKEN1],
  ['unowned stake', CL_GAUGE, 'stakedContains', false],
] as const) test(`refuses ${label}`, async () => {
  const fees = name === 'ownerOf' || name === 'nft';
  const plan = await readAerodromeClaimPlanV1(fixtureReader({
    rows: fees ? [] : [position({ emissions_earned: 1n }), position({ lp: CL_POOL, id: 42n, staked: 1n, emissions_earned: 1n })],
    held: fees ? [unstaked] : [],
    override: (t, n) => t === target && n === name ? replacement : undefined }), WALLET);
  assert.notEqual(plan.errorCode, null);
});
