import { createPublicClient, http, parseAbi, encodeFunctionData, type Address, type Abi } from 'viem';
import { base } from 'viem/chains';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

// Reviewed Sugar v0.4.0 ABI and Aerodrome deployments. Sugar pages POOLS:
// an empty positions page is never the end of the catalogue.
export const AERODROME_SUGAR_V1 = '0x69dd9db6d8f8e7d83887a704f447b1a584b599a1';
export const AERODROME_VOTER_V1 = '0x16613524e02ad97edfef371bc883f2f5d6c480a5';
export const AERODROME_BASIC_FACTORY_V1 = '0x420dd381b31aef6683db6b902084cb0ffece40da';
export const AERODROME_CL_FACTORIES_V1 = [
  '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',
  '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef',
] as const;
export const AERODROME_AERO_V1 = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const ZERO = '0x0000000000000000000000000000000000000000';
export const AERODROME_CLAIM_ABI_V1 = parseAbi([
  'function count() view returns (uint256)',
  'function voter() view returns (address)',
  'function positions(uint256 _limit,uint256 _offset,address _account) view returns ((uint256 id,address lp,uint256 liquidity,uint256 staked,uint256 amount0,uint256 amount1,uint256 staked0,uint256 staked1,uint256 unstaked_earned0,uint256 unstaked_earned1,uint256 emissions_earned,int24 tick_lower,int24 tick_upper,uint160 sqrt_ratio_lower,uint160 sqrt_ratio_upper,address locker,uint32 unlocks_at,address alm)[])',
  'function factory() view returns (address)',
  'function isPool(address) view returns (bool)',
  'function getPool(address,address,int24) view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function gauges(address) view returns (address)',
  'function gauge() view returns (address)',
  'function nft() view returns (address)',
  'function ownerOf(uint256) view returns (address)',
  'function stakedContains(address,uint256) view returns (bool)',
  'function rewardToken() view returns (address)',
  'function stakingToken() view returns (address)',
  'function pool() view returns (address)',
  'function claimFees() returns (uint256,uint256)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  'function getReward(address)',
  'function getReward(uint256)',
]);

export interface AerodromeSugarPositionV1 {
  id: bigint; lp: string; liquidity: bigint; staked: bigint;
  unstaked_earned0: bigint; unstaked_earned1: bigint; emissions_earned: bigint;
  alm: string; locker: string;
}
export interface AerodromeClaimReadV1 {
  blockNumber: bigint;
  read(address: string, name: string, args?: readonly unknown[]): Promise<unknown>;
}
export interface AerodromeClaimItemV1 {
  kind: 'basic_fees' | 'cl_fees' | 'basic_aero' | 'cl_aero';
  pool: string; tokenId: string; token0: string; token1: string;
  amount0: string; amount1: string; aero: string;
  call: ExecutionCallV1;
}
export interface AerodromeClaimPlanV1 {
  blockNumber: string;
  poolsTotal: number; poolsRead: number; poolsUnread: number;
  positionsFound: number; managedSkipped: number;
  calls: AerodromeClaimItemV1[];
  errorCode: string | null;
}

export async function createAerodromeClaimReadV1(): Promise<AerodromeClaimReadV1> {
  const client = createPublicClient({ chain: base, transport: http(
    process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    { timeout: 6_000, retryCount: 0 },
  ) });
  if (await client.getChainId() !== 8453) throw new Error('aerodrome_chain_mismatch');
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  return { blockNumber, read: (address, name, args = []) => client.readContract({
    address: address as Address, abi: AERODROME_CLAIM_ABI_V1 as Abi,
    functionName: name, args, blockNumber,
  }) };
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(value) || value.toLowerCase() === ZERO) {
    throw new Error('aerodrome_target_unverified');
  }
  return value.toLowerCase();
}
function requireEqual(actual: unknown, expected: string): void {
  if (address(actual) !== expected.toLowerCase()) throw new Error('aerodrome_target_mismatch');
}
function call(to: string, signature: string, args: readonly unknown[] = []): ExecutionCallV1 {
  const abi = parseAbi([signature]);
  const functionName = (abi[0] as { name: string }).name;
  return { index: 0, callType: 'other', to: to as Address, valueWei: '0',
    data: encodeFunctionData({ abi: abi as Abi, functionName, args }),
    asset: null, amountAtomic: null, recipient: null, spender: null };
}

/** At most two RPCs are in flight. A failed page splits 500→250→125;
 * unread pages and a catalogue beyond the budget prevent any approval. */
export async function readAerodromeClaimPlanV1(
  reader: AerodromeClaimReadV1,
  wallet: string,
  options: { maxPools?: number; deadlineMs?: number; now?: () => number } = {},
): Promise<AerodromeClaimPlanV1> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 45_000);
  const plan: AerodromeClaimPlanV1 = {
    blockNumber: String(reader.blockNumber), poolsTotal: 0, poolsRead: 0, poolsUnread: 0,
    positionsFound: 0, managedSkipped: 0, calls: [], errorCode: null,
  };
  // The per-read deadline also bounds readers injected by acceptance probes.
  const read = async (target: string, name: string, args?: readonly unknown[]) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('aerodrome_read_deadline');
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([reader.read(target, name, args), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('aerodrome_read_deadline')), Math.min(6_000, remaining));
      })]);
    } finally { clearTimeout(timer!); }
  };
  try {
    address(wallet);
    requireEqual(await read(AERODROME_SUGAR_V1, 'voter'), AERODROME_VOTER_V1);
    const count = await read(AERODROME_SUGAR_V1, 'count');
    if (typeof count !== 'bigint' || count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('aerodrome_catalogue_unreadable');
    plan.poolsTotal = Number(count);
    const limit = Math.min(plan.poolsTotal, options.maxPools ?? 50_000);
    const positions: AerodromeSugarPositionV1[] = [];
    let offset = 0;
    const page = async (start: number, size: number): Promise<void> => {
      try {
        const rows = await read(AERODROME_SUGAR_V1, 'positions', [BigInt(size), BigInt(start), wallet]);
        if (!Array.isArray(rows) || rows.length > 200 || positions.length + rows.length > 200) {
          throw new Error('aerodrome_positions_limit');
        }
        positions.push(...rows as AerodromeSugarPositionV1[]);
        plan.poolsRead += size;
      } catch {
        if (size > 125 && now() < deadline && positions.length < 200) {
          const half = Math.floor(size / 2);
          await page(start, half);
          await page(start + half, size - half);
        }
      }
    };
    const worker = async () => {
      while (offset < limit && now() < deadline && positions.length < 200) {
        const start = offset;
        const size = Math.min(500, limit - start);
        offset += size;
        await page(start, size);
      }
    };
    await Promise.all([worker(), worker()]);
    plan.poolsUnread = plan.poolsTotal - plan.poolsRead;
    plan.positionsFound = positions.length;
    if (plan.poolsUnread > 0) { plan.errorCode = 'aerodrome_incomplete_coverage'; return plan; }
    const seen = new Set<string>();
    for (const position of positions) {
      if (!position || typeof position.alm !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(position.alm)
        || typeof position.locker !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(position.locker)
        || [position.id, position.liquidity, position.staked, position.unstaked_earned0,
          position.unstaked_earned1, position.emissions_earned].some(value => typeof value !== 'bigint' || value < 0n)) {
        throw new Error('aerodrome_position_unreadable');
      }
      if (position.alm.toLowerCase() !== ZERO || position.locker.toLowerCase() !== ZERO) {
        plan.managedSkipped += 1;
        continue;
      }
      const fees = position.unstaked_earned0 > 0n || position.unstaked_earned1 > 0n;
      const rewards = position.emissions_earned > 0n;
      if (!fees && !rewards) continue;
      const pool = address(position.lp);
      const factory = address(await read(pool, 'factory'));
      const cl = position.id > 0n;
      if (cl ? !AERODROME_CL_FACTORIES_V1.includes(factory as typeof AERODROME_CL_FACTORIES_V1[number]) : factory !== AERODROME_BASIC_FACTORY_V1) {
        throw new Error('aerodrome_factory_unreviewed');
      }
      const token0 = address(await read(pool, 'token0'));
      const token1 = address(await read(pool, 'token1'));
      if (cl) {
        requireEqual(await read(factory, 'voter'), AERODROME_VOTER_V1);
        requireEqual(await read(factory, 'getPool', [token0, token1, await read(pool, 'tickSpacing')]), pool);
      } else if (await read(factory, 'isPool', [pool]) !== true) throw new Error('aerodrome_pool_unregistered');
      const item = (kind: AerodromeClaimItemV1['kind'], execution: ExecutionCallV1) => {
        const key = `${kind}:${execution.to}:${cl ? position.id : '0'}`;
        if (seen.has(key)) return;
        seen.add(key);
        plan.calls.push({ kind, pool, tokenId: String(position.id), token0, token1,
          amount0: String(position.unstaked_earned0), amount1: String(position.unstaked_earned1),
          aero: String(position.emissions_earned), call: { ...execution, index: plan.calls.length,
            recipient: wallet as Address } });
      };
      let nft: string | null = null;
      if (cl) {
        nft = address(await read(pool, 'nft'));
        requireEqual(await read(nft, 'factory'), factory);
      }
      // Basic LPs may hold a remainder AND a stake. Both claims are valid.
      if (fees && (!cl || position.staked === 0n)) {
        if (cl) {
          requireEqual(await read(nft!, 'ownerOf', [position.id]), wallet);
          const max = (1n << 128n) - 1n;
          item('cl_fees', call(nft!, 'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)', [
            { tokenId: position.id, recipient: wallet, amount0Max: max, amount1Max: max },
          ]));
        } else item('basic_fees', call(pool, 'function claimFees() returns (uint256,uint256)'));
      }
      if (rewards) {
        const gauge = address(await read(AERODROME_VOTER_V1, 'gauges', [pool]));
        requireEqual(await read(gauge, 'rewardToken'), AERODROME_AERO_V1);
        if (cl) {
          requireEqual(await read(pool, 'gauge'), gauge);
          requireEqual(await read(gauge, 'pool'), pool);
          requireEqual(await read(gauge, 'nft'), nft!);
          if (await read(gauge, 'stakedContains', [wallet, position.id]) !== true) throw new Error('aerodrome_stake_owner_mismatch');
          requireEqual(await read(nft!, 'ownerOf', [position.id]), gauge);
          item('cl_aero', call(gauge, 'function getReward(uint256)', [position.id]));
        } else {
          requireEqual(await read(gauge, 'stakingToken'), pool);
          item('basic_aero', call(gauge, 'function getReward(address)', [wallet]));
        }
      }
      if (plan.calls.length > 20) throw new Error('aerodrome_claim_batch_limit');
    }
  } catch (error) {
    plan.poolsUnread = plan.poolsTotal - plan.poolsRead;
    plan.errorCode = error instanceof Error && /^aerodrome_[a-z_]+$/u.test(error.message)
      ? error.message : 'aerodrome_read_unavailable';
  }
  return plan;
}
