import { getAddress } from 'viem';
import { AERODROME_BASE_ROUTER } from '@mioagent/security/aerodromeGuard';
import { BALANCER_V2_VAULT_BASE_V1, BALANCER_V3_BATCH_ROUTER_BASE_V1, BALANCER_V3_ROUTER_BASE_V1 } from '@mioagent/security/balancerGuard';
import { HYDREX_BASE_ROUTER_PROXY } from '@mioagent/security/hydrexGuard';
import { KYBERSWAP_BASE_ROUTER } from '@mioagent/security/kyberGuard';
import { O1_ZEROX_ALLOWANCE_HOLDER } from '@mioagent/security/o1Guard';
import { BASE_WETH_ADDRESS } from '@mioagent/security/swapAsset';
import { BASE_UNISWAP_UNIVERSAL_ROUTER_2, BASE_UNISWAP_UNIVERSAL_ROUTER_2_1_1, PERMIT2_ADDRESS } from '@mioagent/security/uniswapGuard';

// ---------------------------------------------------------------------------
// Who a send may not pay (audit SS-4, 2026-11-14).
//
// A send's recipient was refused only as the zero address, the wallet itself,
// the token sent and USDC. USDC sent to the NVDAc contract, a stock sent to
// Morpho Blue or to a router: each passed every check, its simulation
// succeeded, and the tokens would have stayed in a contract that never gives
// them back. These are the contracts Miorail's own swaps go through, Permit2
// and the canonical tokens on Base; the server adds every contract Still's
// registry names and every token in the reviewed corpus.
//
// And an address typed in mixed case carries an EIP-55 checksum. One letter
// mistyped in it still made a valid-looking address, and it was taken lower
// case, checksum unread. All lower case (or all upper) carries none and is
// read as written.
// ---------------------------------------------------------------------------

const CANONICAL_BASE_USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** The routers, vaults and token contracts on Base a send never pays, lower case. */
export const SEND_RECIPIENT_CONTRACTS_V1: ReadonlySet<string> = new Set([
  BASE_UNISWAP_UNIVERSAL_ROUTER_2,
  BASE_UNISWAP_UNIVERSAL_ROUTER_2_1_1,
  PERMIT2_ADDRESS,
  KYBERSWAP_BASE_ROUTER,
  AERODROME_BASE_ROUTER,
  BALANCER_V2_VAULT_BASE_V1,
  BALANCER_V3_ROUTER_BASE_V1,
  BALANCER_V3_BATCH_ROUTER_BASE_V1,
  O1_ZEROX_ALLOWANCE_HOLDER,
  HYDREX_BASE_ROUTER_PROXY,
  BASE_WETH_ADDRESS,
  CANONICAL_BASE_USDC_V1,
].map((address) => address.toLowerCase()));

/** True when a typed 0x address is in mixed case and does not match its own EIP-55 checksum. */
export function sendRecipientChecksumBrokenV1(value: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  const hex = value.slice(2);
  if (!/[a-f]/.test(hex) || !/[A-F]/.test(hex)) return false;
  return getAddress(value.toLowerCase()) !== value;
}
