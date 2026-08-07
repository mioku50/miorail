// ---------------------------------------------------------------------------
// T71 verification §3 — what an operator must state before real money moves.
//
// The rule is not "set a flag". It is that no single variable, and no plausible
// typo in one variable, can reach a live grant. Five separate statements are
// required, each naming something an operator can only know if they meant it:
// that this is a live run, whose wallet, which chain, how much per month, how
// much per request. A missing one is a refusal, never a default.
//
// The chain is compared to the literal '8453' rather than parsed. A run against
// the wrong chain must not be reachable by omitting a variable, and `Number('')`
// is 0, which is a value.
//
// The ceilings are here because this is a SMOKE. A paid check costs about a cent;
// a smoke that grants a month of spending at fifty dollars has verified nothing
// extra and risked the difference. An operator who wants a real budget grants it
// in Settings, which is the flow being tested.
// ---------------------------------------------------------------------------

/** Above this, the run is refused. A smoke does not need a real month's budget. */
export const PAID_LIVE_MAX_MONTHLY_ATOMIC_V1 = 1_000_000n; // 1.00 USDC
export const PAID_LIVE_MAX_PER_REQUEST_ATOMIC_V1 = 100_000n; // 0.10 USDC

export interface PaidLiveGateRefusalV1 {
  allowed: false;
  /** Safe: names a variable, never a value. */
  reason: string;
}

export interface PaidLiveGateApprovalV1 {
  allowed: true;
  wallet: string;
  chainId: '8453';
  monthlyUsdc: string;
  monthlyAtomic: string;
  maxPerRequestUsdc: string;
  maxPerRequestAtomic: string;
  /** Revoking is the one step that leaves the operator's own setup changed, so
   * it asks separately rather than riding in on the live flag. */
  allowRevoke: boolean;
  reason: string;
}

export type PaidLiveGateV1 = PaidLiveGateRefusalV1 | PaidLiveGateApprovalV1;

/** Decimal USDC with at most 6 fraction digits -> atomic. Null for anything
 * else, including zero: a zero limit is a permission that can buy nothing. */
export function usdcDecimalToAtomicV1(raw: string): bigint | null {
  const value = raw.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const atomic = BigInt(whole) * 1_000_000n + BigInt(`${fraction}000000`.slice(0, 6) || '0');
  return atomic > 0n ? atomic : null;
}

export function paidIntelligenceLiveGateV1(env: NodeJS.ProcessEnv = process.env): PaidLiveGateV1 {
  const refuse = (reason: string): PaidLiveGateRefusalV1 => ({ allowed: false, reason });

  if ((env.MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE ?? '').trim().toLowerCase() !== 'true') {
    return refuse('MIORAIL_PAID_INTELLIGENCE_LIVE_SMOKE is not true');
  }

  const wallet = (env.MIORAIL_PAID_LIVE_WALLET ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return refuse('MIORAIL_PAID_LIVE_WALLET is not a Base address');

  if ((env.MIORAIL_PAID_LIVE_CHAIN_ID ?? '').trim() !== '8453') {
    return refuse('MIORAIL_PAID_LIVE_CHAIN_ID must be exactly 8453');
  }

  const monthlyUsdc = (env.MIORAIL_PAID_LIVE_MONTHLY_USDC ?? '').trim();
  const monthlyAtomic = usdcDecimalToAtomicV1(monthlyUsdc);
  if (monthlyAtomic === null) return refuse('MIORAIL_PAID_LIVE_MONTHLY_USDC is not a positive USDC amount');

  const maxPerRequestUsdc = (env.MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC ?? '').trim();
  const maxPerRequestAtomic = usdcDecimalToAtomicV1(maxPerRequestUsdc);
  if (maxPerRequestAtomic === null) {
    return refuse('MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC is not a positive USDC amount');
  }

  if (maxPerRequestAtomic > monthlyAtomic) {
    return refuse('MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC exceeds the monthly limit');
  }
  if (monthlyAtomic > PAID_LIVE_MAX_MONTHLY_ATOMIC_V1) {
    return refuse('MIORAIL_PAID_LIVE_MONTHLY_USDC is above 1.00 — a smoke does not need a real month of budget');
  }
  if (maxPerRequestAtomic > PAID_LIVE_MAX_PER_REQUEST_ATOMIC_V1) {
    return refuse('MIORAIL_PAID_LIVE_MAX_PER_REQUEST_USDC is above 0.10 — use the smallest limit that buys one check');
  }

  return {
    allowed: true,
    wallet,
    chainId: '8453',
    monthlyUsdc,
    monthlyAtomic: monthlyAtomic.toString(),
    maxPerRequestUsdc,
    maxPerRequestAtomic: maxPerRequestAtomic.toString(),
    allowRevoke: (env.MIORAIL_PAID_LIVE_ALLOW_REVOKE ?? '').trim().toLowerCase() === 'true',
    reason: `wallet ${wallet}, up to ${monthlyUsdc} USDC/month and ${maxPerRequestUsdc} USDC/request on 8453`,
  };
}
