import { projectCashExitRunV1 } from '@mioagent/rwa-cash-exit';
import type { SwapRouteAdapter } from '@mioagent/swap-adapters';
import {
  StockPositionQuoteInputV1Schema,
  StockPositionQuoteV1Schema,
  stockPositionDecimalV1,
  type StockPositionQuoteV1,
} from '@mioagent/rwa-market-reality/stock-position-quote';
import { stocksDividendsRuntime } from '../routes/stocksDividends.js';
import {
  readStockSellSizeV1,
  rwaMarketRealityRuntime,
  stockSellTermsLimiterV1,
} from '../routes/rwaMarketReality.js';

export class StockPositionQuoteErrorV1 extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export const stockPositionQuoteRuntime = {
  now: () => rwaMarketRealityRuntime.now(),
  available: async () =>
    rwaMarketRealityRuntime.enabled(process.env) &&
    (await stocksDividendsRuntime.storageAvailable()),
  calendar: (now: Date) => stocksDividendsRuntime.calendar(now),
  holding: readStockSellSizeV1,
  measure: rwaMarketRealityRuntime.measureOne,
  repository: () => rwaMarketRealityRuntime.cashExit(),
  adapters: (): readonly SwapRouteAdapter[] => rwaMarketRealityRuntime.quoteAdapters(),
  capture: (): Parameters<
    typeof rwaMarketRealityRuntime.measureOne
  >[0]['captureMarketRealitySnapshots'] => rwaMarketRealityRuntime.capture(),
};

const pending = new Map<string, Promise<StockPositionQuoteV1>>();
const CAVEATS = [
  'This quotes the entire raw token balance at the stated Base block. It does not reserve that balance.',
  'Router output is before network fees. No wallet-specific transfer check or simulation was performed; a quote does not prove execution.',
  'Sources and no-route results apply only to this exact address, amount, USDC destination and measured provider set.',
  'No action is prepared or confirmed. To sell, open the stock and choose an exact amount in its fresh review.',
];

/** Shared by the authenticated web POST and connected MCP. Explicit requests
 * spend bounded provider reads; neither the daily overview nor a timer calls it.
 * Concurrent requests for the same wallet/contract share one measurement. */
export async function measureMyStockCashOutV1(
  wallet: string,
  raw: unknown,
): Promise<StockPositionQuoteV1> {
  wallet = wallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet))
    throw new StockPositionQuoteErrorV1('stock_cash_out_identity_invalid', 401);
  const parsed = StockPositionQuoteInputV1Schema.safeParse(raw);
  if (!parsed.success) throw new StockPositionQuoteErrorV1('stock_cash_out_input_invalid', 400);
  const tokenAddress = parsed.data.tokenAddress.toLowerCase();
  const key = `${wallet}:${tokenAddress}`;
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 64) throw new StockPositionQuoteErrorV1('stock_cash_out_busy', 503);
  const task = (async () => {
    if (!(await stockPositionQuoteRuntime.available()))
      throw new StockPositionQuoteErrorV1('stock_cash_out_unavailable', 503);
    const calendar = await stockPositionQuoteRuntime.calendar(stockPositionQuoteRuntime.now());
    const token = calendar.stocks.find((row) => row.tokenAddress.toLowerCase() === tokenAddress);
    if (!token) throw new StockPositionQuoteErrorV1('stock_cash_out_contract_not_reviewed', 404);
    // Same budget as the SELL review. Web and MCP cannot double the allowance.
    const allowance = await stockSellTermsLimiterV1.current.consume(
      `stock-sell-terms:eip155:8453:${wallet}`,
    );
    if (!allowance.success) throw new StockPositionQuoteErrorV1('stock_cash_out_rate_limited', 429);
    const holding = await stockPositionQuoteRuntime.holding({
      tokenAddress,
      walletAddress: wallet,
    });
    if (!holding.ok) throw new StockPositionQuoteErrorV1('stock_cash_out_balance_unread', 503);
    if (
      !/^\d{1,78}$/.test(holding.balanceAtomic) ||
      BigInt(holding.balanceAtomic) >= 2n ** 256n ||
      !Number.isInteger(holding.decimals) ||
      holding.decimals < 0 ||
      holding.decimals > 36 ||
      !/^0x[0-9a-f]+$/.test(holding.blockTag)
    )
      throw new StockPositionQuoteErrorV1('stock_cash_out_balance_unread', 503);
    const base = {
      schemaVersion: 'my-stock-cash-out/v1' as const,
      chainId: 8453 as const,
      tokenAddress,
      tokenSymbol: token.tokenSymbol,
      holding: {
        balanceAtomic: holding.balanceAtomic,
        tokens: stockPositionDecimalV1(holding.balanceAtomic, holding.decimals),
        decimals: holding.decimals,
        blockTag: holding.blockTag,
      },
      destination: 'USDC' as const,
      destinationDecimals: 6 as const,
      executionProven: false as const,
      createsApproval: false as const,
      createsCalldata: false as const,
      createsTransaction: false as const,
      caveats: CAVEATS,
    };
    if (BigInt(holding.balanceAtomic) === 0n)
      return StockPositionQuoteV1Schema.parse({
        ...base,
        generatedAt: stockPositionQuoteRuntime.now().toISOString(),
        status: 'empty',
        returnedAtomic: null,
        observedAt: null,
        expiresAt: null,
        selectedSource: null,
        approvedSources: [],
        sources: [],
      });
    const adapters = stockPositionQuoteRuntime.adapters();
    const run = await stockPositionQuoteRuntime.measure({
      repository: stockPositionQuoteRuntime.repository(),
      adapters,
      token: {
        address: tokenAddress as `0x${string}`,
        symbol: token.tokenSymbol,
        decimals: holding.decimals,
      },
      walletAddress: wallet as `0x${string}`,
      tenantId: `eip155:8453:${wallet}`,
      scope: 'tenant_position',
      positionTokenAtomic: holding.balanceAtomic,
      destinations: ['USDC'],
      now: stockPositionQuoteRuntime.now,
      captureMarketRealitySnapshots: stockPositionQuoteRuntime.capture(),
    });
    const now = stockPositionQuoteRuntime.now();
    // Verify the complete binding even if a future coordinator caches runs.
    if (
      run.scope !== 'tenant_position' ||
      run.tenantId !== `eip155:8453:${wallet}` ||
      run.chainId !== 8453 ||
      run.tokenAddress.toLowerCase() !== tokenAddress ||
      JSON.stringify([...run.approvedSources].sort()) !==
        JSON.stringify(adapters.map((a) => a.id).sort())
    )
      throw new StockPositionQuoteErrorV1('stock_cash_out_measurement_unread', 503);
    const rows = run.observations.filter(
      (row) =>
        row.sizeKind === 'actual_position' &&
        row.scope === 'tenant_position' &&
        row.tenantId === run.tenantId &&
        row.chainId === 8453 &&
        row.tokenAddress.toLowerCase() === tokenAddress &&
        row.tokenDecimals === holding.decimals &&
        row.requestedTokenAtomic === holding.balanceAtomic &&
        row.testedTokenAtomic === holding.balanceAtomic &&
        row.destination === 'USDC' &&
        row.destinationDecimals === 6 &&
        run.approvedSources.includes(row.source),
    );
    if (
      rows.length !== adapters.length ||
      new Set(rows.map((row) => row.source)).size !== adapters.length
    )
      throw new StockPositionQuoteErrorV1('stock_cash_out_measurement_unread', 503);
    const rung = projectCashExitRunV1({ ...run, observations: rows }, now)[0];
    if (!rung) throw new StockPositionQuoteErrorV1('stock_cash_out_measurement_unread', 503);
    const successes = rows.filter((row) => row.status === 'full' && row.sellQuote !== null);
    const open = successes.filter((row) => Date.parse(row.sellQuote!.expiresAt) > now.getTime());
    const best = [...(open.length ? open : successes)].sort((a, b) => {
      const left = BigInt(a.sellQuote!.outputAtomic),
        right = BigInt(b.sellQuote!.outputAtomic);
      return left === right ? a.source.localeCompare(b.source) : left > right ? -1 : 1;
    })[0];
    return StockPositionQuoteV1Schema.parse({
      ...base,
      generatedAt: now.toISOString(),
      status: open.length
        ? 'quoted'
        : best
          ? 'expired'
          : rung.lastMeasured?.status === 'unavailable'
            ? 'no_route'
            : 'not_established',
      returnedAtomic: best?.sellQuote?.outputAtomic ?? null,
      observedAt: best?.sellQuote?.observedAt ?? rung.lastMeasured?.observedAt ?? null,
      expiresAt: best?.sellQuote?.expiresAt ?? null,
      selectedSource: best?.source ?? null,
      approvedSources: run.approvedSources,
      sources: rows.map((row) => ({
        source: row.source,
        status: row.status,
        errorCode:
          row.errorCode === null
            ? null
            : /^[a-z0-9_.:-]{1,100}$/.test(row.errorCode)
              ? row.errorCode
              : 'provider_read_failed',
      })),
    });
  })();
  pending.set(key, task);
  try {
    return await task;
  } catch (error) {
    throw error instanceof StockPositionQuoteErrorV1
      ? error
      : new StockPositionQuoteErrorV1('stock_cash_out_measurement_unread', 503);
  } finally {
    pending.delete(key);
  }
}
