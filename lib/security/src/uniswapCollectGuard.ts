import type { BaseCall } from './baseGuards.js';
import { stripClaimAttributionV1 } from './aerodromeClaimGuard.js';

/** Uniswap v3's NonfungiblePositionManager on Base. Pinned: a collect sent
 * anywhere else is refused, whatever its calldata says. */
export const UNISWAP_V3_POSITION_MANAGER_BASE_V1 = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const MAX128 = '0'.repeat(32) + 'f'.repeat(32);
/** collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) */
const COLLECT_SELECTOR = '0xfc6f7865';

/**
 * The closed shape of Found's Uniswap collect: one `collect` per position, to
 * the pinned position manager, paying everything owed to the wallet itself,
 * no value, each position once, optional ERC-8021 attribution. Ownership of
 * each position is the vertical's read and the manager's own check: `collect`
 * reverts for anyone but the owner or an approved operator.
 */
export function validateUniswapCollectCallsV1(wallet: string, calls: readonly BaseCall[]): void {
  if (!ADDRESS.test(wallet) || /^0x0{40}$/u.test(wallet) || !calls.length || calls.length > 20) throw new Error('uniswap_collect_invalid');
  const walletWord = '0'.repeat(24) + wallet.slice(2).toLowerCase();
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.to.toLowerCase() !== UNISWAP_V3_POSITION_MANAGER_BASE_V1 || call.value !== '0'
      || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(call.data ?? '')) throw new Error('uniswap_collect_invalid');
    const data = stripClaimAttributionV1(call.data!.toLowerCase(), 'uniswap_collect_suffix_invalid');
    const body = data.slice(10);
    if (data.slice(0, 10) !== COLLECT_SELECTOR || body.length !== 256) throw new Error('uniswap_collect_calldata_refused');
    const tokenId = body.slice(0, 64);
    if (BigInt(`0x${tokenId}`) === 0n || body.slice(64, 128) !== walletWord
      || body.slice(128, 192) !== MAX128 || body.slice(192) !== MAX128) throw new Error('uniswap_collect_calldata_refused');
    if (seen.has(tokenId)) throw new Error('uniswap_collect_duplicate');
    seen.add(tokenId);
  }
}
