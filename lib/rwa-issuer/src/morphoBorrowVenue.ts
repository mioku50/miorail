// The venue writes the unsigned lending calls. The Actions API is the same
// preparer behind Morpho MCP; its raw HTTP exchange is necessary to verify
// Morpho-Action-Proof. Never reconstruct those bytes from an MCP data object.
import { getAddress } from 'viem';
import { partnerFetch } from '@mioagent/security/httpAllowlist';
import { MORPHO_ACTION_ORIGIN_V1, verifyMorphoActionProofV1 } from './morphoActionProof.js';
import type { PreparedTransactionV1 } from './morphoBorrowPlan.js';

/** Discovery metadata; executable preparation uses the raw Actions transport. */
export const MORPHO_MCP_ENDPOINT_V1 = 'https://mcp.morpho.org/';
export const MORPHO_PREPARE_BORROW_TOOL_V1 = 'morpho_prepare_borrow';
export const MORPHO_VENUE_CHAIN_V1 = 'base';
export const MORPHO_VENUE_REFUSALS_V1 = [
  'venue_unreachable', 'venue_refused', 'venue_answer_unreadable',
  'venue_prepared_nothing', 'venue_prepared_another_chain',
  'venue_proof_invalid', 'venue_signature_required', 'venue_expired', 'venue_intent_mismatch',
] as const;
export type MorphoVenueRefusalV1 = (typeof MORPHO_VENUE_REFUSALS_V1)[number];
export interface MorphoVenueClaimedTransferV1 {
  tokenAddress: string | null; tokenSymbol: string | null; to: string | null; amount: string | null;
}
export interface MorphoPreparedBorrowV1 {
  transactions: readonly PreparedTransactionV1[];
  venueSimulation: { reverted: boolean; reason: string | null } | null;
  claimedTransfers: readonly MorphoVenueClaimedTransferV1[];
  requirements: readonly string[];
  maxBorrowableAssets: bigint | null;
  summary: string | null;
  expiresAt: string;
}
export type MorphoPrepareBorrowResultV1 =
  | { ok: true; prepared: MorphoPreparedBorrowV1 }
  | { ok: false; refusal: MorphoVenueRefusalV1; detail: string | null };
export interface MorphoVenueDepsV1 {
  fetchImpl?: typeof fetch;
  /** Only the fixed official production origin is accepted. */
  endpoint?: string;
  timeoutMs?: number;
  requestId?: string;
  now?: () => Date;
}

/** For display only. Actions requests always use an exact integer string. */
export function atomicToDecimalStringV1(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError('decimals must be an integer between 0 and 36');
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const address = (value: unknown): string | null => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
const amount = (value: unknown): string | null => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? value : null;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

export async function prepareMorphoBorrowV1(input: {
  marketId: string; walletAddress: string; borrowAssets: bigint; loanDecimals: number;
  loanTokenAddress?: string; collateralTokenAddress?: string;
  /** Exact ERC-20 collateral selected by the person. Omitted means no new supply. */
  collateralSupplyAssets?: bigint;
  deps?: MorphoVenueDepsV1;
}): Promise<MorphoPrepareBorrowResultV1> {
  const deps = input.deps ?? {};
  const fail = (refusal: MorphoVenueRefusalV1, detail: string | null = null): MorphoPrepareBorrowResultV1 => ({ ok: false, refusal, detail });
  const marketId = input.marketId.trim().toLowerCase();
  const wallet = address(input.walletAddress.trim());
  const supply = input.collateralSupplyAssets;
  const selectedCollateral = address(input.collateralTokenAddress);
  if (!/^0x[0-9a-f]{64}$/.test(marketId) || !wallet || /^0x0{40}$/.test(wallet) || input.borrowAssets <= 0n || input.borrowAssets >= 1n << 256n ||
      !Number.isInteger(input.loanDecimals) || input.loanDecimals < 0 || input.loanDecimals > 36) return fail('venue_answer_unreadable', 'the intent was not exact');
  if (supply !== undefined && (typeof supply !== 'bigint' || supply <= 0n || supply >= 1n << 256n || !selectedCollateral || /^0x0{40}$/.test(selectedCollateral))) {
    return fail('venue_answer_unreadable', 'the selected collateral supply was not exact');
  }
  if (deps.endpoint !== undefined && deps.endpoint !== MORPHO_ACTION_ORIGIN_V1) return fail('venue_refused', 'only the official Actions origin is supported');
  const path = `/v0/actions/blue/markets/8453:${marketId}/borrow`;
  const requestBytes = new TextEncoder().encode(JSON.stringify({
    account: getAddress(wallet), amount: { unit: 'assets', value: input.borrowAssets.toString() }, signature_mode: 'none',
    ...(supply === undefined ? {} : { collateral_amount: { unit: 'assets', value: supply.toString() }, funding: { type: 'erc20' } }),
  }));
  let response: Response, bytes: Uint8Array;
  try {
    response = await partnerFetch(`${MORPHO_ACTION_ORIGIN_V1}${path}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: requestBytes,
    }, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs ?? 15_000 });
    if (!response.ok) return fail(response.status >= 400 && response.status < 500 && response.status !== 429 ? 'venue_refused' : 'venue_unreachable', `the venue returned HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 2_000_000) return fail('venue_answer_unreadable', 'the answer was too large');
  } catch {
    return fail('venue_unreachable', 'the venue could not be reached');
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('venue_answer_unreadable', 'the answer was not JSON'); }
  if (!object(payload) || !object(payload.data)) return fail('venue_answer_unreadable', 'the Actions envelope was not readable');
  const data = payload.data;
  const now = deps.now?.() ?? new Date();
  const proof = await verifyMorphoActionProofV1({ response, responseBytes: bytes, requestBytes, path, data, now, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
  if (!proof.ok) return fail('venue_proof_invalid', 'the exact Actions response could not be authenticated');
  if (data.chain_id !== 8453) return fail('venue_prepared_another_chain');
  if (address(data.account) !== wallet || data.action !== 'blue.borrow') return fail('venue_intent_mismatch');
  if (!Number.isSafeInteger(data.expires_at) || data.expires_at * 1000 <= now.getTime() || proof.expiresAtMs <= now.getTime()) return fail('venue_expired');
  if (data.status === 'signature_required') return fail('venue_signature_required', 'this path does not request typed-data signatures');
  if (data.status === 'simulation_failed') return fail('venue_refused', 'the venue simulation failed');
  if (data.status !== 'prepared' || !object(data.simulation) || data.simulation.status !== 'success') return fail('venue_answer_unreadable', 'the venue did not establish a successful preparation');
  if (!object(data.market) || typeof data.market.id !== 'string' || data.market.id.toLowerCase() !== marketId ||
      !object(data.amount) || data.amount.unit !== 'assets' || amount(data.amount.value) !== input.borrowAssets.toString() ||
      !object(data.resolved_amount) || data.resolved_amount.unit !== 'assets' || amount(data.resolved_amount.value) !== input.borrowAssets.toString() ||
      !address(data.market.loan_asset?.address) || !address(data.market.collateral_asset?.address) ||
      (input.loanTokenAddress !== undefined && address(data.market.loan_asset?.address) !== address(input.loanTokenAddress)) ||
      (input.collateralTokenAddress !== undefined && address(data.market.collateral_asset?.address) !== address(input.collateralTokenAddress)) ||
      data.funding !== undefined || data.referral_fee !== undefined) return fail('venue_intent_mismatch');
  const effects = data.simulation.effects;
  if (!object(effects) || amount(effects.gross_assets) !== input.borrowAssets.toString() ||
      amount(effects.net_assets) !== input.borrowAssets.toString() || amount(effects.referral_fee_assets) !== '0') return fail('venue_intent_mismatch', 'the venue effects do not match the requested net arrival');
  if (supply === undefined) {
    if (data.collateral_amount !== undefined || data.resolved_funding !== undefined || effects.supplied_collateral_assets !== undefined) {
      return fail('venue_intent_mismatch', 'this borrow requested no new collateral or funding');
    }
  } else {
    const collateralAmount = data.collateral_amount, funding = data.resolved_funding;
    if (!object(collateralAmount) || !exactKeys(collateralAmount, ['unit', 'value']) ||
        collateralAmount.unit !== 'assets' || amount(collateralAmount.value) !== supply.toString() ||
        !object(funding) || !exactKeys(funding, ['wrapped_asset', 'max_native_assets', 'erc20_assets', 'native_assets']) ||
        address(funding.wrapped_asset) !== selectedCollateral || amount(funding.erc20_assets) !== supply.toString() ||
        amount(funding.max_native_assets) !== '0' || amount(funding.native_assets) !== '0' ||
        amount(effects.supplied_collateral_assets) !== supply.toString()) {
      return fail('venue_intent_mismatch', 'the venue funding or supplied collateral differs from the exact selection');
    }
  }
  if (!Array.isArray(data.calls) || data.calls.length === 0) return fail('venue_prepared_nothing');
  if (data.calls.length > 4) return fail('venue_answer_unreadable', 'too many calls');
  const transactions: PreparedTransactionV1[] = [];
  const ids = new Set<string>();
  const finalKind = supply === undefined ? 'blue_borrow' : 'blue_supply_collateral_borrow';
  for (const [index, call] of data.calls.entries()) {
    // Prerequisites precede exactly one final action. Preserve the array order,
    // but never accept a different action merely because the proof is valid.
    const expectedKind = index === data.calls.length - 1 ? call?.kind === finalKind : ['approval', 'authorization'].includes(call?.kind);
    if (!object(call) || !expectedKind || typeof call.id !== 'string' || !/^call_[0-9]+$/.test(call.id) || ids.has(call.id) ||
        !address(call.to) || typeof call.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(call.data) || amount(call.value) !== '0' ||
        (call.chainId !== undefined && call.chainId !== 8453)) return fail('venue_answer_unreadable', 'a prepared call did not match this borrow');
    ids.add(call.id);
    transactions.push({ to: call.to, data: call.data, value: call.value, description: call.kind });
  }
  return { ok: true, prepared: {
    transactions, venueSimulation: { reverted: false, reason: null }, claimedTransfers: [], requirements: [],
    maxBorrowableAssets: null, summary: null,
    expiresAt: new Date(Math.min(data.expires_at * 1000, proof.expiresAtMs)).toISOString(),
  } };
}
