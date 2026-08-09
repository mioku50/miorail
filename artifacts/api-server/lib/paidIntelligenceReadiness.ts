import { x402ConfigFromEnv, type X402RuntimeConfig } from '@mioagent/x402-gateway';
import {
  paidB20SimulationEnabledV1,
  resolvePaidB20SimulationPricingV1,
  simulationPriceUsdcForPrepareResponseV1,
} from './paidIntelligenceConfig.js';

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
  /** What is priced, and at what. Only surfaces that are actually switched on
   * AND have a readable price appear — a client that sees no entry renders no
   * paid control, which is the correct behaviour for a surface the server
   * would refuse anyway. */
  pricedSurfaces?: {
    b20ExitProof?: { priceUsdc: string };
    swapSimulation?: { priceUsdc: string };
  };
}

/** Reads the two paid surfaces straight from env, so the price a client shows
 * and the price the x402 middleware charges come from ONE resolution. */
export function pricedSurfacesV1(
  env: NodeJS.ProcessEnv = process.env,
): PaidIntelligenceStatusV1['pricedSurfaces'] {
  const surfaces: NonNullable<PaidIntelligenceStatusV1['pricedSurfaces']> = {};
  if (paidB20SimulationEnabledV1(env)) {
    const pricing = resolvePaidB20SimulationPricingV1(env);
    // An unreadable price is not advertised. The route fails closed on the
    // same condition, so the two agree instead of the screen promising a
    // number the server will refuse.
    if (pricing) surfaces.b20ExitProof = { priceUsdc: pricing.decimalUsdc };
  }
  const swapPrice = simulationPriceUsdcForPrepareResponseV1(env);
  if (swapPrice) surfaces.swapSimulation = { priceUsdc: swapPrice };
  return Object.keys(surfaces).length > 0 ? surfaces : undefined;
}

export function paidIntelligenceReadinessV1(
  flagEnabled: boolean,
  x402Config: X402RuntimeConfig = x402ConfigFromEnv(),
  env: NodeJS.ProcessEnv = process.env,
): PaidIntelligenceStatusV1 {
  const settleReady = x402Config.settleReady === true;
  if (!flagEnabled) {
    // Nothing is priced when the mechanism is off, whatever the surface flags
    // say. Listing a price here would let a client offer a paid control that
    // the gateway could never settle.
    return { flagEnabled: false, settleReady, readiness: 'disabled' };
  }
  const pricedSurfaces = pricedSurfacesV1(env);
  if (settleReady) {
    return { flagEnabled: true, settleReady: true, readiness: 'ready', pricedSurfaces };
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
