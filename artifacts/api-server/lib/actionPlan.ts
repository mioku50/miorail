// T19: server-side action plan builder. Encodes a minimal safe onchain action
// (ERC-20 `transfer` of canonical Base Mainnet USDC) into an execution payload
// the client can submit via Base Account `wallet_sendCalls`. Unknown or unsafe
// intents fall back to a read-only payload (no calls) — the server never
// broadcasts, so producing real calldata here is safe even under
// `mainnet-readonly`.
//
// This is intentionally narrow: only `transfer(address,uint256)` of native USDC
// is encoded. Anything else (swaps, approvals, arbitrary contracts) stays
// read-only until a dedicated, screened builder exists for it.

import { encodeFunctionData, parseUnits, isAddress, type Address, type Hex, erc20Abi } from 'viem';
import { screenAction } from '@mioagent/security';

export interface ActionCall {
  to: string;
  value?: string;
  data?: string;
}

export interface ExecutionPayload {
  chain: string;
  readOnly?: boolean;
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

// Parses "transfer/send <amount> USDC to <0x address>" (case-insensitive,
// flexible whitespace). Returns null if it does not match a safe transfer.
function parseUsdcTransfer(instruction: string): { amount: string; recipient: Address } | null {
  // Amount: integer or decimal. Unit: USDC (allow USDC.e / USDbC? no — native only).
  const match = instruction.match(/\b(?:transfer|send)\s+([\d.]+)\s+usdc\s+to\s+(0x[a-fA-F0-9]{40})\b/i);
  if (!match) return null;
  const amountStr = match[1];
  const recipient = match[2] as Address;
  if (!isAddress(recipient)) return null;
  // Reject malformed amounts (multiple dots, leading/trailing dot).
  if (!/^\d+(\.\d+)?$/.test(amountStr)) return null;
  return { amount: amountStr, recipient };
}

const USDC_DECIMALS = 6;

// Builds an execution payload for a recognized safe action. Falls back to a
// read-only payload ({ calls: [] }) for anything unrecognized or screened.
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

  // 2. Only encode a recognized safe USDC transfer on Base Mainnet. Sepolia
  //    keeps its existing placeholder/readonly path (testnet exercise handled
  //    elsewhere).
  if (ctx.chainEnv === 'mainnet-readonly' || ctx.chainEnv === 'mainnet') {
    const parsed = parseUsdcTransfer(instruction);
    if (parsed) {
      try {
        const units = parseUnits(parsed.amount, USDC_DECIMALS);
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [parsed.recipient, units],
        });
        return {
          chain: 'eip155:8453',
          calls: [
            {
              to: getBaseMainnetUsdcAddress(),
              value: '0',
              data: data as Hex,
            },
          ],
        };
      } catch {
        // parseUnits/encodeFunctionData should not fail for validated input,
        // but fail closed if they do.
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
