// T19: server-side action plan builder. Encodes a minimal safe onchain action
// into an execution payload the client can submit via Base Account
// `wallet_sendCalls`. Unknown or unsafe intents fall back to a read-only
// payload (no calls) — the server never broadcasts, so producing real calldata
// here is safe even under `mainnet-readonly`.
//
// T19.1: the production action-type whitelist is exactly two intents:
//   - `revoke_approval`  → ERC-20 `approve(spender, 0)` on canonical USDC.
//     This is the PREFERRED first mainnet action (no funds move). Tried first.
//   - `limited_transfer` → ERC-20 `transfer(recipient, amount)` of canonical
//     USDC, capped by MAX_LIMITED_TRANSFER_USDC (default 100). Over-cap amounts
//     fail closed to a read-only plan.
// Anything else (swaps, arbitrary contracts, over-cap transfers) stays
// read-only until a dedicated, screened builder exists for it.

import { encodeFunctionData, parseUnits, isAddress, type Address, type Hex, erc20Abi } from 'viem';
import { screenAction } from '@mioagent/security';

/** The only onchain action types the user-confirmed flow may surface. */
export type ProductionActionType = 'revoke_approval' | 'limited_transfer';

export interface ActionCall {
  to: string;
  value?: string;
  data?: string;
}

export interface ExecutionPayload {
  chain: string;
  readOnly?: boolean;
  /** Present only for whitelisted production action types; absent on read-only plans. */
  actionType?: ProductionActionType;
  calls: ActionCall[];
}

export interface BuildActionPlanContext {
  chainEnv: string;
  walletAddress?: string;
}

// Canonical Base Mainnet native USDC (Circle, 6 decimals). NOT the bridged
// USDbC. Env-overridable for deployments that pin a different token.
export function getBaseMainnetUsdcAddress(): Address {
  const fromEnv = process.env.BASE_MAINNET_USDC_ADDRESS;
  if (fromEnv && isAddress(fromEnv)) return fromEnv as Address;
  return '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
}

// T19.1: maximum USDC a `limited_transfer` may move. Over-cap → read-only.
// Env-overridable; defaults to 100 USDC.
export function getMaxLimitedTransferUsdc(): number {
  const raw = process.env.MAX_LIMITED_TRANSFER_USDC;
  const parsed = raw ? Number(raw) : 100;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

const USDC_DECIMALS = 6;

// Parses "transfer/send <amount> USDC to <0x address>" (case-insensitive,
// flexible whitespace). Returns null if it does not match a safe transfer.
function parseUsdcTransfer(instruction: string): { amount: string; recipient: Address } | null {
  // Amount: integer or decimal. Unit: USDC (native only).
  const match = instruction.match(/\b(?:transfer|send)\s+([\d.]+)\s+usdc\s+to\s+(0x[a-fA-F0-9]{40})\b/i);
  if (!match) return null;
  const amountStr = match[1];
  const recipient = match[2] as Address;
  if (!isAddress(recipient)) return null;
  // Reject malformed amounts (multiple dots, leading/trailing dot).
  if (!/^\d+(\.\d+)?$/.test(amountStr)) return null;
  return { amount: amountStr, recipient };
}

// T19.1: parses "revoke (USDC)? approval (for|to) <0x spender>" — the preferred
// first mainnet action (no funds move). Returns null if it does not match.
function parseRevokeApproval(instruction: string): { spender: Address } | null {
  const match = instruction.match(/\brevoke\s+(?:usdc\s+)?approval\s+(?:for|to)\s+(0x[a-fA-F0-9]{40})\b/i);
  if (!match) return null;
  const spender = match[1] as Address;
  if (!isAddress(spender)) return null;
  return { spender };
}

// Builds an execution payload for a recognized safe action. Falls back to a
// read-only payload ({ calls: [] }) for anything unrecognized, screened, or
// over the limited-transfer cap.
export function buildActionPlan(instruction: string, ctx: BuildActionPlanContext): ExecutionPayload {
  const chain = ctx.chainEnv === 'sepolia' ? 'eip155:84532' : 'eip155:8453';

  // 1. Instruction must pass security screening before we encode any calldata.
  const secProvider = process.env.TOKEN_SECURITY_PROVIDER || 'none';
  const screen = screenAction({
    instruction,
    providerContext: {
      risk: secProvider === 'goplus' ? 'connected' : 'missing',
      riskProvider: secProvider,
      securityProvider: secProvider,
    },
  });
  if (!screen.allowed) {
    return { chain, readOnly: true, calls: [] };
  }

  // 2. Only encode recognized safe actions on Base Mainnet. Sepolia keeps its
  //    existing placeholder/readonly path (testnet exercise handled elsewhere).
  if (ctx.chainEnv === 'mainnet-readonly' || ctx.chainEnv === 'mainnet') {
    const usdc = getBaseMainnetUsdcAddress();

    // T19.1: prefer revoke_approval (safest first mainnet action) over transfer.
    const revoke = parseRevokeApproval(instruction);
    if (revoke) {
      try {
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [revoke.spender, 0n],
        });
        return {
          chain: 'eip155:8453',
          actionType: 'revoke_approval',
          calls: [{ to: usdc, value: '0', data: data as Hex }],
        };
      } catch {
        return { chain: 'eip155:8453', readOnly: true, calls: [] };
      }
    }

    // limited_transfer: bounded USDC transfer. Over-cap → fail closed.
    const parsed = parseUsdcTransfer(instruction);
    if (parsed) {
      try {
        const units = parseUnits(parsed.amount, USDC_DECIMALS);
        const capUnits = parseUnits(String(getMaxLimitedTransferUsdc()), USDC_DECIMALS);
        if (units > capUnits) {
          // Over the limited-transfer cap: do not encode. Stay read-only.
          return { chain: 'eip155:8453', readOnly: true, calls: [] };
        }
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [parsed.recipient, units],
        });
        return {
          chain: 'eip155:8453',
          actionType: 'limited_transfer',
          calls: [{ to: usdc, value: '0', data: data as Hex }],
        };
      } catch {
        return { chain: 'eip155:8453', readOnly: true, calls: [] };
      }
    }
  }

  // 3. Unrecognized or non-mainnet intent: read-only, no calls.
  return { chain, readOnly: true, calls: [] };
}

// True when the plan actually carries onchain calls (vs. a read-only report).
export function planHasCalls(plan: ExecutionPayload): boolean {
  return Array.isArray(plan.calls) && plan.calls.length > 0;
}
