import { x402ConfigFromEnv, type X402RuntimeConfig } from '@mioagent/x402-gateway';

// ---------------------------------------------------------------------------
// T67X-A1 — whether paid intelligence can actually take money.
//
// `MIORAIL_PAID_INTELLIGENCE=true` says an operator WANTS paid routes. It says
// nothing about whether the facilitator will settle. Those came apart in
// practice: `X402_FACILITATOR_URL` was set, so everything reported configured,
// and the first real payment failed at settlement — after the user had signed.
//
// A configured URL is not a settlement path. Settlement needs a working
// authorization: an `X402_FACILITATOR_AUTH_TOKEN`, or a complete CDP API key
// pair. Without one, every paid call ends in a 503 from the middleware, and the
// only honest thing to report before that happens is `blocked`.
//
// Deliberately NOT a boot failure. Free route comparison, evidence, scoring and
// proofs need no facilitator at all, and taking the server down because a paid
// feature is misconfigured would turn a degraded feature into an outage.
// ---------------------------------------------------------------------------

export type PaidIntelligenceReadinessV1 = 'ready' | 'blocked' | 'disabled';

export interface PaidIntelligenceStatusV1 {
  /** MIORAIL_PAID_INTELLIGENCE. */
  flagEnabled: boolean;
  /** The gateway believes settlement can complete. */
  settleReady: boolean;
  readiness: PaidIntelligenceReadinessV1;
  /** Present only when readiness is `blocked`. */
  blockedReason?: string;
}

export function paidIntelligenceReadinessV1(
  flagEnabled: boolean,
  x402Config: X402RuntimeConfig = x402ConfigFromEnv(),
): PaidIntelligenceStatusV1 {
  const settleReady = x402Config.settleReady === true;
  if (!flagEnabled) {
    return { flagEnabled: false, settleReady, readiness: 'disabled' };
  }
  if (settleReady) {
    return { flagEnabled: true, settleReady: true, readiness: 'ready' };
  }
  return {
    flagEnabled: true,
    settleReady: false,
    readiness: 'blocked',
    // The gateway's own reason, not a re-derived one: two explanations of the
    // same failure eventually disagree, and this is the one the 503 will carry.
    blockedReason: x402Config.settleBlockedReason ?? 'settlement_not_ready',
  };
}
