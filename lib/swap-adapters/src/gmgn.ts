import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { gmgnReadFetchV1 } from '@mioagent/runtime-skills';
import { resolvePluginCredential } from '@mioagent/security/httpAllowlist';
import { buildQuoteArtifacts } from './candidate.js';
import {
  canonicalRequestHash, canonicalResponseHash, minimumOutputAtomic,
  normalizeAddress, protocolAllowsAdapter, routablePairV1, supportsRoutableSwapIntentV1,
} from './normalization.js';
import type { SwapAdapterQuoteInput, SwapAdapterResult, SwapRouteAdapter } from './types.js';

const ORIGIN = 'https://openapi.gmgn.ai';
const NATIVE = '0x0000000000000000000000000000000000000000';
const UINT = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine(value => BigInt(value) < 2n ** 256n);
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const QuoteSchema = z.object({
  code: z.literal(0),
  data: z.object({
    input_token: ADDRESS, output_token: ADDRESS,
    input_amount: UINT, output_amount: UINT, min_output_amount: UINT,
    slippage: z.number().int().min(0).max(100),
    tx: z.object({
      chain_id: z.literal(8453), from_address: ADDRESS,
      input_token_address: ADDRESS, output_token_address: ADDRESS,
      amount_in: UINT, amount_out: UINT, amount_min_out: UINT,
      amount_in_decimals: z.number().int().min(0).max(255),
      amount_out_decimals: z.number().int().min(0).max(255),
      slippage: z.number().int().min(0).max(100),
      deadline: z.number().int().positive().max(253402300799),
    }),
  }),
});

export interface GmgnQuoteAdapterOptionsV1 {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
  clock?: () => number;
}

/** Quotes only. Provider calldata, approvals and URLs never leave this reader. */
export class GmgnQuoteRouteAdapter implements SwapRouteAdapter {
  readonly id = 'gmgn' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly credential: string | undefined;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(options: GmgnQuoteAdapterOptionsV1 = {}) {
    // The operator's own key or nothing. Base's spec publishes a read key that
    // GMGN calls a demo limited per IP, and from 2026-10-06 GMGN answered it
    // from this server with 429 on every request; quotes are paused until a
    // key is configured, and nothing is sent in the meantime.
    this.credential = options.apiKey ?? resolvePluginCredential('gmgn');
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.clock = options.clock ?? Date.now;
    this.fetchImpl = gmgnReadFetchV1(options.fetchImpl, this.clock);
  }

  supports(intent: SwapAdapterQuoteInput['intent']): boolean {
    // Keep a quote-only source out of automatic execution comparisons. The
    // caller must explicitly select it; registry selection enforces this too.
    return supportsRoutableSwapIntentV1(intent)
      && protocolAllowsAdapter(intent, this.id)
      && intent.protocolConstraint.mode === 'include_only'
      && intent.protocolConstraint.protocols.includes(this.id)
      && Boolean(intent.fromAsset && intent.toAsset && routablePairV1(intent.fromAsset, intent.toAsset));
  }

  async quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    const failure = (errorCode: string, outcome: 'unsupported' | 'unavailable' | 'timeout' | 'rate_limited' | 'invalid_response') => ({
      outcome, provider: this.id, errorCode,
      retryable: ['unavailable', 'timeout', 'rate_limited'].includes(outcome),
    } as const);
    if (!this.supports(input.intent)) return failure('provider_unsupported_intent', 'unsupported');
    if (!this.credential) return failure('provider_not_configured', 'unavailable');
    if (!normalizeAddress(input.walletAddress) || input.walletAddress.toLowerCase() !== input.intent.walletAddress) {
      return failure('gmgn_wallet_mismatch', 'invalid_response');
    }
    const from = input.intent.fromAsset!;
    const to = input.intent.toAsset!;
    const inputToken = from.kind === 'native' ? NATIVE : normalizeAddress(from.address);
    const outputToken = to.kind === 'native' ? NATIVE : normalizeAddress(to.address);
    if (!inputToken || !outputToken) return failure('provider_unsupported_intent', 'unsupported');
    // GMGN documents INTEGER percentages. Round down, never widen the user's
    // maximum: the default 50 bps requests 0%, not an invented 1% tolerance.
    const slippage = Math.floor(input.intent.slippageConstraint.maxBps / 100);
    const safeRequest = {
      chain: 'base', from_address: input.walletAddress.toLowerCase(),
      input_token: inputToken, output_token: outputToken,
      input_amount: input.intent.amount.amountAtomic, slippage,
    };
    const params = new URLSearchParams(Object.entries(safeRequest).map(([key, value]) => [key, String(value)]));
    params.set('timestamp', String(Math.floor(this.clock() / 1000)));
    params.set('client_id', randomUUID());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${ORIGIN}/v1/trade/quote?${params}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'X-APIKEY': this.credential, accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return response.status === 429
          ? failure('provider_rate_limited', 'rate_limited')
          : failure(`gmgn_http_${response.status}`, 'unavailable');
      }
      // Bound the stream before JSON parsing, including chunked responses.
      const reader = response.body?.getReader();
      if (!reader) return failure('provider_invalid_schema', 'invalid_response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 128 * 1024) {
            await reader.cancel();
            return failure('provider_invalid_schema', 'invalid_response');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return failure('provider_invalid_schema', 'invalid_response'); }
      const parsed = QuoteSchema.safeParse(payload);
      if (!parsed.success) return failure('provider_invalid_schema', 'invalid_response');
      const data = parsed.data.data;
      const tx = data.tx;
      if (data.input_token.toLowerCase() !== inputToken || data.output_token.toLowerCase() !== outputToken
        || tx.input_token_address.toLowerCase() !== inputToken || tx.output_token_address.toLowerCase() !== outputToken
        || tx.from_address.toLowerCase() !== safeRequest.from_address
        || data.input_amount !== safeRequest.input_amount || tx.amount_in !== safeRequest.input_amount
        || tx.amount_in_decimals !== from.decimals || tx.amount_out_decimals !== to.decimals) {
        return failure('provider_asset_mismatch', 'invalid_response');
      }
      if (data.slippage !== slippage || tx.slippage !== slippage) {
        return failure('provider_slippage_echo_mismatch', 'invalid_response');
      }
      if (data.output_amount !== tx.amount_out || data.min_output_amount !== tx.amount_min_out
        || BigInt(data.output_amount) === 0n || BigInt(data.min_output_amount) === 0n
        || BigInt(data.min_output_amount) > BigInt(data.output_amount)) {
        return failure('provider_invalid_schema', 'invalid_response');
      }
      if (BigInt(data.min_output_amount) < BigInt(minimumOutputAtomic(data.output_amount, slippage * 100))) {
        return failure('provider_slippage_echo_mismatch', 'invalid_response');
      }
      const expiry = Math.min(tx.deadline * 1000, input.now.getTime() + 20_000);
      if (expiry <= input.now.getTime()) return failure('provider_expired_quote', 'invalid_response');
      // Only validated price fields enter hashes/evidence. No calldata, router,
      // approval, credentials, auth nonce or provider prose enters the result.
      const safeResponse = {
        inputToken, outputToken, amountIn: data.input_amount,
        expectedOutput: data.output_amount, minimumOutput: data.min_output_amount,
        inputDecimals: from.decimals, outputDecimals: to.decimals, slippage, deadline: tx.deadline,
      };
      const artifacts = buildQuoteArtifacts({
        adapterId: this.id, intent: input.intent,
        provider: { id: this.id, displayName: 'GMGN', kind: 'aggregator', operator: 'GMGN' },
        requestId: input.requestId, providerQuoteId: null,
        requestHash: canonicalRequestHash(this.id, safeRequest),
        responseHash: canonicalResponseHash(this.id, safeResponse),
        expectedOutputAtomic: data.output_amount, providerMinimumOutputAtomic: data.min_output_amount,
        gas: { gasUnits: '0', maxFeePerGasWei: null, estimatedCostNative: null, estimatedCostUsd: null },
        priceImpactBps: null, observedAt: input.now.toISOString(), expiresAt: new Date(expiry).toISOString(),
        blockNumber: null, provenance: { pools: [], liquiditySources: [] },
        riskFlags: ['quote_only', 'gas_unmeasured', 'price_impact_unmeasured', 'liquidity_sources_unmeasured'],
        usesExternalAggregators: true, sourceIndependence: 'unknown', callCount: 0, approvalCount: 0,
      });
      return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
    } catch {
      return controller.signal.aborted
        ? failure('provider_timeout', 'timeout') : failure('provider_unreachable', 'unavailable');
    } finally { clearTimeout(timer); }
  }
}
