import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import type { ExecutionCallV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// Uncollected Uniswap v3 fees, read from Base for one wallet.
//
// Uniswap's own position manager answers the question exactly: `collect`,
// dry-run FROM the owner, pokes the pool and returns what a real collect
// would pay. Nothing else is trusted for an amount. The manager is pinned by
// address, so every position read here is a real Uniswap v3 position, and a
// collect can only pay the owner's own fees to the owner.
//
// v4 positions live in a different manager that keeps no per-owner index, so
// they are counted here and not read: finding them takes the manager's whole
// transfer history.
// ---------------------------------------------------------------------------

export const UNISWAP_V3_POSITION_MANAGER_V1 = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
export const UNISWAP_V4_POSITION_MANAGER_V1 = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
/** Positions read at once. A wallet holding more is told so, never cut. */
export const UNISWAP_POSITIONS_LIMIT_V1 = 100;
/** Positions collected in one approval. */
export const UNISWAP_COLLECT_LIMIT_V1 = 20;
const MAX128 = (1n << 128n) - 1n;
const VIEW_BATCH = 50;
const COLLECT_BATCH = 20;

export const UNISWAP_V3_POSITIONS_ABI_V1 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);

export interface UniswapViewCallV1 { address: string; name: 'balanceOf' | 'tokenOfOwnerByIndex' | 'positions'; args: readonly unknown[] }

export interface UniswapFeesReadDepsV1 {
  blockNumber: bigint;
  /** Views at the block, answered in order; any revert fails the batch. */
  readMany(calls: readonly UniswapViewCallV1[]): Promise<unknown[]>;
  /** What `collect` would pay the wallet for each position, dry-run from the
   * wallet at the block, or null where that position's collect reverts. */
  dryCollect(wallet: string, tokenIds: readonly bigint[]): Promise<([bigint, bigint] | null)[]>;
}

export interface UniswapFeePositionV1 {
  tokenId: string;
  token0: string;
  token1: string;
  /** The pool's fee tier, in hundredths of a basis point (500 = 0.05%). */
  fee: number;
  amount0: string;
  amount1: string;
}

export interface UniswapFeesPlanV1 {
  blockNumber: string;
  /** v3 position NFTs the wallet holds. */
  positionsHeld: number;
  /** Of them, the ones with liquidity or owed tokens: closed ones pay nothing. */
  positionsOpen: number;
  /** v4 position NFTs the wallet holds, counted and not read. */
  v4PositionsHeld: number;
  /** Open positions whose collect reverted: excluded, and said. */
  unreadable: number;
  /** The positions with something to collect. */
  positions: UniswapFeePositionV1[];
  errorCode: string | null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

function count(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('uniswap_read_invalid');
  return Number(value);
}

function addressOf(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(value)) throw new Error('uniswap_read_invalid');
  return value.toLowerCase();
}

/** Every v3 position the wallet holds, and what each would pay it now. */
export async function readUniswapFeesPlanV1(deps: UniswapFeesReadDepsV1, walletAddress: string): Promise<UniswapFeesPlanV1> {
  const wallet = walletAddress.toLowerCase();
  const [heldRaw, v4Raw] = await deps.readMany([
    { address: UNISWAP_V3_POSITION_MANAGER_V1, name: 'balanceOf', args: [wallet] },
    { address: UNISWAP_V4_POSITION_MANAGER_V1, name: 'balanceOf', args: [wallet] },
  ]);
  const plan: UniswapFeesPlanV1 = {
    blockNumber: deps.blockNumber.toString(), positionsHeld: count(heldRaw), positionsOpen: 0,
    v4PositionsHeld: count(v4Raw), unreadable: 0, positions: [], errorCode: null,
  };
  if (plan.positionsHeld === 0) return plan;
  if (plan.positionsHeld > UNISWAP_POSITIONS_LIMIT_V1) return { ...plan, errorCode: 'uniswap_positions_limit' };

  const ids: bigint[] = [];
  for (const batch of chunks(Array.from({ length: plan.positionsHeld }, (_, index) => index), VIEW_BATCH)) {
    const answers = await deps.readMany(batch.map((index) => ({
      address: UNISWAP_V3_POSITION_MANAGER_V1, name: 'tokenOfOwnerByIndex' as const, args: [wallet, BigInt(index)],
    })));
    for (const id of answers) {
      if (typeof id !== 'bigint' || id <= 0n) throw new Error('uniswap_read_invalid');
      ids.push(id);
    }
  }
  const open: { tokenId: bigint; token0: string; token1: string; fee: number }[] = [];
  for (const batch of chunks(ids, VIEW_BATCH)) {
    const answers = await deps.readMany(batch.map((tokenId) => ({
      address: UNISWAP_V3_POSITION_MANAGER_V1, name: 'positions' as const, args: [tokenId],
    })));
    answers.forEach((answer, index) => {
      if (!Array.isArray(answer) || answer.length !== 12) throw new Error('uniswap_read_invalid');
      const [liquidity, owed0, owed1] = [answer[7], answer[10], answer[11]];
      if (typeof liquidity !== 'bigint' || typeof owed0 !== 'bigint' || typeof owed1 !== 'bigint') throw new Error('uniswap_read_invalid');
      if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return;
      open.push({ tokenId: batch[index]!, token0: addressOf(answer[2]), token1: addressOf(answer[3]), fee: Number(answer[4]) });
    });
  }
  plan.positionsOpen = open.length;
  for (const batch of chunks(open, COLLECT_BATCH)) {
    const paid = await deps.dryCollect(wallet, batch.map((position) => position.tokenId));
    if (paid.length !== batch.length) throw new Error('uniswap_read_invalid');
    batch.forEach((position, index) => {
      const amounts = paid[index];
      if (!amounts) { plan.unreadable += 1; return; }
      const [amount0, amount1] = amounts;
      if (amount0 < 0n || amount1 < 0n) throw new Error('uniswap_read_invalid');
      if (amount0 === 0n && amount1 === 0n) return;
      plan.positions.push({ tokenId: position.tokenId.toString(), token0: position.token0, token1: position.token1,
        fee: position.fee, amount0: amount0.toString(), amount1: amount1.toString() });
    });
  }
  return plan;
}

/** The collect call for one position: everything owed, to the owner. */
export function uniswapCollectCallV1(tokenId: string, wallet: string, index = 0): ExecutionCallV1 {
  return {
    index, callType: 'other', to: UNISWAP_V3_POSITION_MANAGER_V1 as Address, valueWei: '0',
    data: encodeFunctionData({ abi: UNISWAP_V3_POSITIONS_ABI_V1, functionName: 'collect',
      args: [{ tokenId: BigInt(tokenId), recipient: wallet.toLowerCase() as Address, amount0Max: MAX128, amount1Max: MAX128 }] }),
    asset: null, amountAtomic: null, recipient: null, spender: null,
  };
}

function readRpcUrlV1(): string {
  return process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
}

/** The production reader: Multicall3 for views, and the manager's own
 * `multicall` for the dry-run collect, which keeps the wallet as the caller. */
export async function createUniswapFeesReadV1(): Promise<UniswapFeesReadDepsV1> {
  const client = createPublicClient({ chain: base, transport: http(readRpcUrlV1(), { timeout: 8_000, retryCount: 1 }) });
  if (await client.getChainId() !== 8453) throw new Error('uniswap_chain_mismatch');
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const collectData = (wallet: string, tokenId: bigint): Hex => encodeFunctionData({
    abi: UNISWAP_V3_POSITIONS_ABI_V1, functionName: 'collect',
    args: [{ tokenId, recipient: wallet as Address, amount0Max: MAX128, amount1Max: MAX128 }],
  });
  const decodeCollect = (data: Hex): [bigint, bigint] => {
    const [amount0, amount1] = decodeFunctionResult({ abi: UNISWAP_V3_POSITIONS_ABI_V1, functionName: 'collect', data }) as readonly [bigint, bigint];
    return [amount0, amount1];
  };
  const callFrom = async (wallet: string, data: Hex): Promise<Hex> => {
    const answer = await client.call({ account: wallet as Address, to: UNISWAP_V3_POSITION_MANAGER_V1 as Address, data, blockNumber });
    if (!answer.data) throw new Error('uniswap_read_invalid');
    return answer.data;
  };
  return {
    blockNumber,
    readMany: (calls) => client.multicall({
      contracts: calls.map(({ address, name, args }) => ({
        address: address as Address, abi: UNISWAP_V3_POSITIONS_ABI_V1 as Abi, functionName: name, args,
      })),
      allowFailure: false, batchSize: 0, blockNumber,
    }) as Promise<unknown[]>,
    dryCollect: async (wallet, tokenIds) => {
      const datas = tokenIds.map((tokenId) => collectData(wallet, tokenId));
      try {
        const results = decodeFunctionResult({
          abi: UNISWAP_V3_POSITIONS_ABI_V1, functionName: 'multicall',
          data: await callFrom(wallet, encodeFunctionData({ abi: UNISWAP_V3_POSITIONS_ABI_V1, functionName: 'multicall', args: [datas] })),
        }) as readonly Hex[];
        return results.map(decodeCollect);
      } catch {
        // One position's collect reverted the batch: ask each alone, so one
        // bad token does not hide the rest. A transport failure is not a
        // revert, and fails the reading instead of hiding a position.
        return Promise.all(datas.map((data) => callFrom(wallet, data).then(decodeCollect, (error: unknown) => {
          if (revertedV1(error)) return null;
          throw error;
        })));
      }
    },
  };
}

/** Whether an eth_call failed because the call reverted, as opposed to the
 * request failing: JSON-RPC code 3, or "execution reverted" anywhere in the
 * cause chain. */
export function revertedV1(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; details?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 3 || /revert/iu.test(String(record.details ?? '')) || /revert/iu.test(String(record.message ?? ''))
      || /Revert/u.test(String(record.name ?? ''))) return true;
    current = record.cause;
  }
  return false;
}
