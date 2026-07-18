import { keccak256, stringToHex } from 'viem';

// T58: the only two assets Route Proof reconciliation can honestly reconstruct
// from onchain ERC-20 Transfer logs. Any output asset outside this pair (most
// notably native ETH, which has no Transfer log to observe) routes to
// `reconciliation_required` instead of a fabricated actual result.
export const CANONICAL_BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const CANONICAL_BASE_WETH = '0x4200000000000000000000000000000000000006' as const;

/** keccak256("Transfer(address,address,uint256)") — computed at module load
 * (not hardcoded) so the constant is verifiably correct. */
export const ERC20_TRANSFER_TOPIC0 = keccak256(stringToHex('Transfer(address,address,uint256)'));

/** Terminal Route Proof statuses: reconciliation never re-opens these. */
export const ROUTE_PROOF_TERMINAL_FINAL_STATUSES = [
  'completed',
  'partial_failure',
  'failed',
  'cancelled',
] as const;
