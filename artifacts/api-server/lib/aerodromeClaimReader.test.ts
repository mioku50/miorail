import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData } from 'viem';
import {
  AERODROME_SUGAR_V1, AERODROME_VOTER_V1, AERODROME_BASIC_FACTORY_V1,
  AERODROME_CL_FACTORIES_V1, AERODROME_AERO_V1, AERODROME_CLAIM_ABI_V1,
  readAerodromeClaimPlanV1, type AerodromeClaimReadV1, type AerodromeSugarPositionV1,
} from './aerodromeClaimReader.js';

export const WALLET = '0x1111111111111111111111111111111111111111';
export const POOL = '0x2222222222222222222222222222222222222222';
export const CL_POOL = '0x3333333333333333333333333333333333333333';
export const GAUGE = '0x4444444444444444444444444444444444444444';
export const CL_GAUGE = '0x5555555555555555555555555555555555555555';
export const MANAGER = '0x6666666666666666666666666666666666666666';
const TOKEN0 = '0x7777777777777777777777777777777777777777';
const TOKEN1 = '0x8888888888888888888888888888888888888888';
const ZERO = '0x0000000000000000000000000000000000000000';
export function position(overrides: Partial<AerodromeSugarPositionV1> = {}): AerodromeSugarPositionV1 {
  return { id: 0n, lp: POOL, liquidity: 0n, staked: 0n, unstaked_earned0: 10n,
    unstaked_earned1: 0n, emissions_earned: 0n, alm: ZERO, locker: ZERO, ...overrides };
}
export function fixtureReader(options: {
  rows?: AerodromeSugarPositionV1[]; count?: number; rowOffset?: number;
  override?: (target: string, name: string, args: readonly unknown[]) => unknown;
  page?: (limit: number, offset: number) => Promise<AerodromeSugarPositionV1[]>;
} = {}): AerodromeClaimReadV1 {
  return { blockNumber: 100n, async read(target, name, args = []) {
    const replacement = options.override?.(target, name, args);
    if (replacement !== undefined) return replacement;
    if (target === AERODROME_SUGAR_V1 && name === 'count') return BigInt(options.count ?? 500);
    if (name === 'positions') {
      const [limit, offset] = args.map(Number);
      if (options.page) return options.page(limit, offset);
      const at = options.rowOffset ?? 0;
      return offset <= at && at < offset + limit ? options.rows ?? [position()] : [];
    }
    if (name === 'voter') return AERODROME_VOTER_V1;
    if (name === 'factory') return target === POOL ? AERODROME_BASIC_FACTORY_V1 : AERODROME_CL_FACTORIES_V1[1];
    if (name === 'isPool') return true;
    if (name === 'token0') return TOKEN0;
    if (name === 'token1') return TOKEN1;
    if (name === 'getPool') return CL_POOL;
    if (name === 'tickSpacing') return 100;
    if (name === 'nft') return MANAGER;
    if (name === 'ownerOf') return args[0] === 42n ? CL_GAUGE : WALLET;
    if (name === 'gauges') return args[0] === POOL ? GAUGE : CL_GAUGE;
    if (name === 'gauge') return CL_GAUGE;
    if (name === 'pool') return CL_POOL;
    if (name === 'stakingToken') return POOL;
    if (name === 'rewardToken') return AERODROME_AERO_V1;
    if (name === 'stakedContains') return true;
    throw new Error(`unexpected fixture read: ${name}`);
  } };
}

test('builds all four claims, including fees after withdrawing LP and mixed basic stake', async () => {
  const rows = [position({ emissions_earned: 5n, staked: 10n }),
    position({ lp: CL_POOL, id: 41n }),
    position({ lp: CL_POOL, id: 42n, staked: 10n, emissions_earned: 8n })];
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ rows }), WALLET);
  assert.equal(plan.errorCode, null);
  assert.deepEqual(plan.calls.map(item => item.kind), ['basic_fees', 'basic_aero', 'cl_fees', 'cl_aero']);
  assert.deepEqual(plan.calls.map(item => item.call.to), [POOL, GAUGE, MANAGER, CL_GAUGE]);
  for (const item of plan.calls) assert.equal(item.call.valueWei, '0');
  const collect = decodeFunctionData({ abi: AERODROME_CLAIM_ABI_V1, data: plan.calls[2].call.data });
  assert.equal(collect.functionName, 'collect');
  const args = collect.args as any;
  assert.equal(args[0].recipient.toLowerCase(), WALLET);
  assert.equal(args[0].tokenId, 41n);
  assert.equal(args[0].amount0Max, (1n << 128n) - 1n);
  assert.equal(decodeFunctionData({ abi: AERODROME_CLAIM_ABI_V1, data: plan.calls[3].call.data }).args?.[0], 42n);
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
for (const [label, target, name, replacement] of [
  ['foreign factory', POOL, 'factory', TOKEN1],
  ['spoofed registered pool', AERODROME_BASIC_FACTORY_V1, 'isPool', false],
  ['foreign Sugar voter', AERODROME_SUGAR_V1, 'voter', TOKEN1],
  ['foreign gauge', GAUGE, 'stakingToken', TOKEN1],
  ['foreign reward token', GAUGE, 'rewardToken', TOKEN1],
  ['foreign CL gauge', CL_POOL, 'gauge', TOKEN1],
  ['unowned NFT', MANAGER, 'ownerOf', TOKEN1],
  ['foreign manager factory', MANAGER, 'factory', TOKEN1],
  ['unregistered CL pool', AERODROME_CL_FACTORIES_V1[1], 'getPool', TOKEN1],
  ['unowned stake', CL_GAUGE, 'stakedContains', false],
] as const) test(`refuses ${label}`, async () => {
  const rows = name === 'ownerOf' ? [position({ lp: CL_POOL, id: 41n })]
    : [position({ emissions_earned: 1n }), position({ lp: CL_POOL, id: 42n, staked: 1n, emissions_earned: 1n })];
  const plan = await readAerodromeClaimPlanV1(fixtureReader({ rows,
    override: (t, n) => t === target && n === name ? replacement : undefined }), WALLET);
  assert.notEqual(plan.errorCode, null);
});
