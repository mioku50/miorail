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
import { getBaseMainnetUsdcAddress as getCanonicalBaseMainnetUsdcAddress } from '@mioagent/security/baseGuards';
import type { TokenApproval } from '@mioagent/data-providers';

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
  memoryMd?: string | null;
  securityProviderContext?: {
    risk?: string;
    riskProvider?: string;
    securityProvider?: string;
    requiresTokenSecurity?: boolean;
  };
  /**
   * T19.2: provider-discovered token approvals for the wallet. When present,
   * a `revoke_approval` intent is only encoded if a real NONZERO allowance
   * exists for the parsed spender — so we never surface a confirmable revoke
   * for a spender the wallet hasn't actually approved. When absent, revoke
   * fails closed to read-only (the caller — /recommend — handles the
   * "no active approval found" response before reaching this path).
   */
  approvals?: TokenApproval[];
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
// T19.2: exported so /recommend can run the approval lookup before deciding
// whether to surface a confirmable revoke or a "no active approval found" note.
export function parseRevokeApproval(instruction: string): { spender: Address; tokenSymbol?: string } | null {
  if (!/\b(?:revoke|remove)\b/i.test(instruction)) return null;
  if (!/\b(?:approval|approvals|allowance|allowances|permission|permissions|spend)\b/i.test(instruction)) return null;
  const spenderMatch = instruction.match(/(0x[a-fA-F0-9]{40})/i);
  if (!spenderMatch) return null;
  const spender = spenderMatch[1] as Address;
  if (!isAddress(spender)) return null;

  const prefix = instruction.slice(0, spenderMatch.index);
  const cleaned = prefix.replace(/\b(?:revoke|remove|spend|permission|permissions|approval|approvals|allowance|allowances|for|to|from|of|my|the|a|an|token|tokens)\b/gi, '').trim();
  const tokenSymbol = cleaned ? cleaned.split(/\s+/)[0] : undefined;

  return { spender, tokenSymbol };
}

// T19.2/T19.3: finds a real, NONZERO provider-discovered approval for `spender`.
// Returns the matching approval or null. A zero allowance is treated as "already revoked" — not
// an active approval — so we never offer a confirmable revoke for nothing.
export function findActiveApproval(
  approvals: TokenApproval[] | undefined,
  spender: Address,
  tokenFilter?: string,
): TokenApproval | null {
  if (!Array.isArray(approvals)) return null;
  const target = spender.toLowerCase();
  const filter = tokenFilter?.toLowerCase();
  for (const a of approvals) {
    if (a.spenderAddress.toLowerCase() !== target) continue;
    if (a.allowanceRaw === '0' || (!a.isUnlimited && Number(a.allowanceFormatted) === 0)) continue;
    if (filter) {
      const addrMatch = a.tokenAddress.toLowerCase() === filter;
      const symbolMatch = (a.tokenSymbol || '').toLowerCase() === filter;
      if (!addrMatch && !symbolMatch) continue;
    }
    return a;
  }
  return null;
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
    memoryMd: ctx.memoryMd,
    providerContext: ctx.securityProviderContext || {
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
    const usdc = getCanonicalBaseMainnetUsdcAddress() as Address;

    // T19.1/T19.3: prefer revoke_approval (safest first mainnet action) over transfer.
    const revoke = parseRevokeApproval(instruction);
    if (revoke) {
      // T19.2/T19.3: approval-gated. Only encode a confirmable revoke when the wallet
      // has a real nonzero allowance to this spender — never for a spender that
      // isn't in the provider's approval data. No approval data ⇒ fail closed
      // (read-only). /recommend surfaces the "no active approval found" note
      // before reaching here, but buildActionPlan stays safe on its own.
      const active = findActiveApproval(ctx.approvals, revoke.spender, revoke.tokenSymbol);
      if (!active) {
        return { chain: 'eip155:8453', readOnly: true, calls: [] };
      }
      try {
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [revoke.spender, 0n],
        });
        return {
          chain: 'eip155:8453',
          actionType: 'revoke_approval',
          calls: [{ to: active.tokenAddress as Address, value: '0', data: data as Hex }],
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
