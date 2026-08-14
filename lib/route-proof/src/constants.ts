import { keccak256, stringToHex } from 'viem';

// The closed asset set the swap Route Proof reconciler understands on Base.
export const CANONICAL_BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const CANONICAL_BASE_WETH = '0x4200000000000000000000000000000000000006' as const;

/** keccak256("Transfer(address,address,uint256)") — computed at module load
 * (not hardcoded) so the constant is verifiably correct. */
export const ERC20_TRANSFER_TOPIC0 = keccak256(stringToHex('Transfer(address,address,uint256)'));
/** Canonical WETH9 wrap/unwrap events. The event actor is checked against the
 * exact approved call target before it can stand in for native ETH movement. */
export const WETH_DEPOSIT_TOPIC0 = keccak256(stringToHex('Deposit(address,uint256)'));
export const WETH_WITHDRAWAL_TOPIC0 = keccak256(stringToHex('Withdrawal(address,uint256)'));

/** Terminal Route Proof statuses: reconciliation never re-opens these. */
export const ROUTE_PROOF_TERMINAL_FINAL_STATUSES = [
  'completed',
  'partial_failure',
  'failed',
  'cancelled',
] as const;
