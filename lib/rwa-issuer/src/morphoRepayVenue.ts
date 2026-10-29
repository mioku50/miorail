import { getAddress } from 'viem';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import { MORPHO_ACTION_ORIGIN_V1, verifyMorphoActionProofV1 } from './morphoActionProof.js';
import type { PreparedTransactionV1 } from './morphoBorrowPlan.js';
import type { MorphoVenueDepsV1, MorphoVenueRefusalV1 } from './morphoBorrowVenue.js';
import type { MorphoRepayAmountV1 } from './morphoRepayMath.js';
import { MORPHO_REPAY_USDC_BASE_V1 } from './morphoRepayPlan.js';

/** Optional external Actions preparation. This adapter authenticates the raw
 * exchange, then binds it to the exact repayment intent. The canonical byte
 * guard and independent simulation are additional, mandatory checks. */
export interface MorphoPreparedRepayV1 {
  transactions: readonly PreparedTransactionV1[];
  venueSimulation: { reverted: boolean; reason: string | null };
  maximumAssets: bigint;
  resolvedAmount: { unit: 'assets' | 'shares'; value: bigint };
  repaidAssets: bigint;
  repaidShares: bigint;
  /** The shorter of action expiry and authenticated proof lifetime. */
  expiresAt: string;
  /** Exact action expiry for binding the onchain deadline, not proof TTL. */
  actionExpiresAt: string;
  prepareSource: 'authenticated_actions_api';
}
export type MorphoPrepareRepayResultV1 = { ok: true; prepared: MorphoPreparedRepayV1 } |
  { ok: false; refusal: MorphoVenueRefusalV1; detail: string | null };

type RecordV1 = Record<string, unknown>;
const object = (v: unknown): v is RecordV1 => typeof v === 'object' && v !== null && !Array.isArray(v);
const address = (v: unknown): string | null => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
const atomic = (v: unknown): bigint | null => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v)) return null;
  const n = BigInt(v); return n < 1n << 256n ? n : null;
};
const max128 = (1n << 128n) - 1n;
const uint128 = (v: unknown): v is bigint => typeof v === 'bigint' && v >= 0n && v <= max128;
const keys = (v: RecordV1, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));

async function boundedBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  let length = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) throw new Error('response too large');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const out = new Uint8Array(length);
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export async function prepareMorphoRepayV1(input: {
  marketId: string;
  walletAddress: string;
  amount: MorphoRepayAmountV1;
  maximumAssets: bigint;
  loanTokenAddress: string;
  collateralTokenAddress: string;
  deps?: MorphoVenueDepsV1;
}): Promise<MorphoPrepareRepayResultV1> {
  const deps = input.deps ?? {};
  const fail = (refusal: MorphoVenueRefusalV1, detail: string | null = null): MorphoPrepareRepayResultV1 => ({ ok: false, refusal, detail });
  const marketId = input.marketId.trim().toLowerCase();
  const wallet = address(input.walletAddress);
  const collateral = address(input.collateralTokenAddress);
  if (!/^0x[0-9a-f]{64}$/.test(marketId) || !wallet || /^0x0{40}$/.test(wallet) ||
      !collateral || /^0x0{40}$/.test(collateral) || collateral === MORPHO_REPAY_USDC_BASE_V1 ||
      address(input.loanTokenAddress) !== MORPHO_REPAY_USDC_BASE_V1 ||
      !uint128(input.maximumAssets) || input.maximumAssets === 0n ||
      (input.amount.mode !== 'assets' && input.amount.mode !== 'all') ||
      (input.amount.mode === 'assets' && (!uint128(input.amount.assets) || input.amount.assets === 0n || input.amount.assets > input.maximumAssets))) {
    return fail('venue_answer_unreadable', 'The repayment identity, amount and maximum were not exact.');
  }
  if (deps.endpoint !== undefined && deps.endpoint !== MORPHO_ACTION_ORIGIN_V1) return fail('venue_refused', 'Only the official Actions origin is supported.');
  const path = `/v0/actions/blue/markets/8453:${marketId}/repay`;
  const amount = input.amount.mode === 'assets' ? { unit: 'assets', value: input.amount.assets.toString() } : { unit: 'all' };
  const requestBytes = new TextEncoder().encode(JSON.stringify({ account: getAddress(wallet), amount, funding: { type: 'erc20' }, signature_mode: 'none' }));
  let response: Response, bytes: Uint8Array;
  try {
    response = await partnerFetch(`${MORPHO_ACTION_ORIGIN_V1}${path}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: requestBytes,
    }, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs ?? 15_000 });
    if (!response.ok) return fail(response.status >= 400 && response.status < 500 && response.status !== 429 ? 'venue_refused' : 'venue_unreachable', `The venue returned HTTP ${response.status}.`);
    bytes = await boundedBytes(response);
  } catch { return fail('venue_unreachable', 'The repayment venue could not be reached or its response was not bounded.'); }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('venue_answer_unreadable', 'The repayment answer was not JSON.'); }
  if (!object(payload) || !object(payload.data)) return fail('venue_answer_unreadable', 'The Actions envelope was not readable.');
  const data = payload.data;
  const now = deps.now?.() ?? new Date();
  const proof = await verifyMorphoActionProofV1({ response, responseBytes: bytes, requestBytes, path, data, now, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!proof.ok) return fail('venue_proof_invalid', 'The exact Actions repayment exchange could not be authenticated.');
  if (data.chain_id !== 8453) return fail('venue_prepared_another_chain');
  if (address(data.account) !== wallet || data.action !== 'blue.repay') return fail('venue_intent_mismatch');
  if (!Number.isSafeInteger(data.expires_at) || (data.expires_at as number) * 1000 <= now.getTime() || proof.expiresAtMs <= now.getTime()) return fail('venue_expired');
  if (data.status === 'signature_required') return fail('venue_signature_required', 'Repayment does not request typed-data signatures.');
  if (data.status === 'simulation_failed') return fail('venue_refused', 'The venue repayment simulation failed.');
  if (data.status !== 'prepared' || !object(data.simulation) || data.simulation.status !== 'success') return fail('venue_answer_unreadable', 'The venue did not establish a successful preparation.');
  const market = data.market;
  if (!object(market) || typeof market.id !== 'string' || market.id.toLowerCase() !== marketId ||
      !object(market.loan_asset) || address(market.loan_asset.address) !== MORPHO_REPAY_USDC_BASE_V1 ||
      !object(market.collateral_asset) || address(market.collateral_asset.address) !== collateral ||
      !object(data.amount) || !keys(data.amount, input.amount.mode === 'assets' ? ['unit', 'value'] : ['unit']) ||
      data.amount.unit !== input.amount.mode || (input.amount.mode === 'assets' && atomic(data.amount.value) !== input.amount.assets) ||
      data.referral_fee !== undefined || data.collateral_amount !== undefined || data.funding !== undefined || data.signatures !== undefined) return fail('venue_intent_mismatch');
  const maximum = atomic(data.max_repay_assets);
  const funding = data.resolved_funding;
  const fundingAssets = object(funding) ? atomic(funding.erc20_assets) : null;
  if (maximum === null || maximum <= 0n || maximum > input.maximumAssets ||
      !object(funding) || !keys(funding, ['wrapped_asset', 'max_native_assets', 'erc20_assets', 'native_assets']) ||
      address(funding.wrapped_asset) !== MORPHO_REPAY_USDC_BASE_V1 || atomic(funding.max_native_assets) !== 0n || atomic(funding.native_assets) !== 0n ||
      fundingAssets === null || fundingAssets <= 0n || fundingAssets > maximum) return fail('venue_intent_mismatch', 'The venue funding is not bounded ERC-20 USDC.');
  // The schema does not establish whether erc20_assets is the gross maximum
  // or the simulated debit. It is never used as either authority here.
  const resolved = data.resolved_amount;
  const resolvedValue = object(resolved) ? atomic(resolved.value) : null;
  const effects = data.simulation.effects;
  const repaidAssets = object(effects) ? atomic(effects.repaid_assets) : null;
  const repaidShares = object(effects) ? atomic(effects.repaid_shares) : null;
  if (!object(resolved) || !keys(resolved, ['unit', 'value']) || (resolved.unit !== 'assets' && resolved.unit !== 'shares') ||
      resolvedValue === null || resolvedValue <= 0n || !object(effects) || !keys(effects, ['repaid_assets', 'repaid_shares', 'referral_fee_assets'], ['ltv_bps', 'max_ltv_bps']) ||
      repaidAssets === null || repaidAssets <= 0n || repaidAssets > maximum || repaidShares === null || repaidShares <= 0n || atomic(effects.referral_fee_assets) !== 0n ||
      (resolved.unit === 'assets' ? resolvedValue !== repaidAssets : resolvedValue !== repaidShares) ||
      (input.amount.mode === 'assets' && (resolved.unit !== 'assets' || resolvedValue !== input.amount.assets || repaidAssets !== input.amount.assets))) {
    return fail('venue_intent_mismatch', 'The repayment effects do not match this fee-free exact intent.');
  }
  if (!Array.isArray(data.calls) || data.calls.length === 0) return fail('venue_prepared_nothing');
  if (data.calls.length > 4) return fail('venue_answer_unreadable', 'Too many repayment calls.');
  const transactions: PreparedTransactionV1[] = [];
  const ids = new Set<string>();
  let repaymentCalls = 0;
  for (const call of data.calls) {
    if (!object(call) || (call.kind !== 'blue_repay' && call.kind !== 'approval') ||
        typeof call.id !== 'string' || !/^call_[0-9]+$/.test(call.id) || ids.has(call.id) || !address(call.to) ||
        typeof call.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(call.data) || atomic(call.value) !== 0n ||
        (call.chainId !== undefined && call.chainId !== 8453)) return fail('venue_answer_unreadable', 'A call did not match repayment-only preparation.');
    if (call.kind === 'blue_repay') repaymentCalls++;
    ids.add(call.id);
    transactions.push({ to: call.to as string, data: call.data, value: '0', description: call.kind as string });
  }
  if (repaymentCalls !== 1) return fail('venue_intent_mismatch', 'Exactly one repayment action is required.');
  return { ok: true, prepared: { transactions, venueSimulation: { reverted: false, reason: null }, maximumAssets: maximum,
    resolvedAmount: { unit: resolved.unit, value: resolvedValue }, repaidAssets, repaidShares,
    expiresAt: new Date(Math.min((data.expires_at as number) * 1000, proof.expiresAtMs)).toISOString(),
    actionExpiresAt: new Date((data.expires_at as number) * 1000).toISOString(), prepareSource: 'authenticated_actions_api' } };
}
