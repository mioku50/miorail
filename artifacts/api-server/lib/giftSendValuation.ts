import {
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  hashRouteIntentV1,
  stableHashV1,
  type AssetRefV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import {
  KyberSwapRouteAdapter,
  UniswapSwapRouteAdapter,
  type SwapAdapterResult,
  type SwapRouteAdapter,
} from '@mioagent/swap-adapters';

import { CANONICAL_BASE_USDC_V1, type StockValuationV1 } from './stockGift.js';

// ---------------------------------------------------------------------------
// What a gift from holdings is worth: what the amount would fetch in USDC now.
//
// The gift range is in dollars ($0.10–$100) and nothing is paid for a gift
// from holdings, so its value is read the way the recipient could realise it —
// a sell quote, token → canonical USDC, from the two routers every stock trade
// already asks. The better answer is kept. A quote is only a read: nothing is
// built from it, approved, or sent, and it is never shown as a price the
// recipient is promised.
//
// No quote from either router is no value, and the gift is not offered — the
// caller says so as a read that failed, never as a fact about the stock.
// ---------------------------------------------------------------------------

const USDC_V1: AssetRefV1 = {
  assetId: `eip155:8453/erc20:${CANONICAL_BASE_USDC_V1}`,
  chainId: 8453,
  kind: 'erc20',
  address: CANONICAL_BASE_USDC_V1,
  symbol: 'USDC',
  decimals: 6,
};

/** How long one router is waited for. A slow router is no answer from it. */
const QUOTE_TIMEOUT_MS_V1 = 8_000;

function decimalV1(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The sell question, asked as the routers expect a swap to be asked. */
export function giftValuationIntentV1(input: {
  token: AssetRefV1;
  amountAtomic: string;
  walletAddress: `0x${string}`;
  now: Date;
}): RouteIntentV1 {
  const wallet = input.walletAddress.toLowerCase() as `0x${string}`;
  const timestamp = input.now.toISOString();
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: `gift-valuation:${stableHashV1('gift-valuation/v1', {
      wallet,
      token: input.token.address,
      amountAtomic: input.amountAtomic,
      at: timestamp,
    }).slice(2)}`,
    tenantId: `eip155:8453:${wallet}`,
    walletAddress: wallet,
    chainId: 8453,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset: input.token,
    toAsset: USDC_V1,
    amount: {
      asset: input.token,
      amountAtomic: input.amountAtomic,
      amountDecimal: decimalV1(input.amountAtomic, input.token.decimals),
    },
    optimizationMode: 'best_net_result',
    verificationDepth: 'standard',
    protocolConstraint: { mode: 'any', protocols: [] },
    slippageConstraint: { maxBps: 100, source: 'policy' },
    // A read. Nothing is executed from this intent, and it is never stored.
    executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

async function quoteWithin(adapter: SwapRouteAdapter, input: Parameters<SwapRouteAdapter['quote']>[0]): Promise<SwapAdapterResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.quote(input),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), QUOTE_TIMEOUT_MS_V1);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The better of the routers' USDC answers for this amount, or null. */
export async function valueStockInUsdcV1(
  input: { token: AssetRefV1; amountAtomic: string; walletAddress: `0x${string}`; now: Date },
  adapters: readonly SwapRouteAdapter[] = [new UniswapSwapRouteAdapter(), new KyberSwapRouteAdapter()],
): Promise<StockValuationV1> {
  const intent = giftValuationIntentV1(input);
  const answers = await Promise.all(
    adapters
      .filter((adapter) => adapter.supports(intent))
      .map((adapter) =>
        quoteWithin(adapter, {
          intent,
          walletAddress: intent.walletAddress,
          requestId: `${intent.id}:${adapter.id}`,
          now: input.now,
        }),
      ),
  );
  let best: NonNullable<StockValuationV1> | null = null;
  for (const answer of answers) {
    if (!answer || answer.outcome !== 'quoted') continue;
    const output = answer.candidate.expectedOutput;
    // Only an answer in canonical USDC is a dollar figure.
    if (output.asset.address?.toLowerCase() !== CANONICAL_BASE_USDC_V1 || !/^[0-9]+$/.test(output.amountAtomic)) continue;
    if (!best || BigInt(output.amountAtomic) > BigInt(best.usdcAtomic)) {
      best = {
        usdcAtomic: output.amountAtomic,
        provider: answer.candidate.provider.id,
        observedAt: answer.candidate.quoteObservedAt,
      };
    }
  }
  return best;
}
