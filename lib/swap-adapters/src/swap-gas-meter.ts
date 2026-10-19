import { encodeFunctionData, erc20Abi } from 'viem';
import type { GasEstimateV1 } from '@mioagent/route-domain';

// ---------------------------------------------------------------------------
// Gas for a quote whose provider states none.
//
// Hydrex's quote carries no gas field at all, so every Hydrex candidate was
// left unscored (`gas_usd_valuation_unavailable`) and could never be ranked —
// including, on 2026-10-19, one that quoted 0.1% more than KyberSwap. The swap
// is measured instead: its approval and its call, run once with
// `eth_simulateV1` against the wallet's real balances, and the swap call's own
// gas priced at the chain's gas price. Measured the same day for 2 USDC →
// SONYc: Hydrex's swap used 411,295 gas, KyberSwap's 326,860 against its own
// stated 357,363 — so a simulated figure is comparable with a stated one.
//
// Nothing is overridden. A wallet that cannot afford the swap gets no figure,
// and the candidate stays unscored as before rather than being priced on
// state that is not its own.
// ---------------------------------------------------------------------------

export interface SwapGasPriceV1 {
  gasPriceWei: bigint;
  /** Dollars per ETH, as a decimal string — never a float that can print as
   * an exponent. */
  ethUsd: string;
}

export interface SwapGasMeterV1 {
  /** The swap call's gas, priced now, or null when it could not be measured. */
  measure(input: {
    walletAddress: `0x${string}`;
    approval: { token: `0x${string}`; spender: `0x${string}`; amountAtomic: string } | null;
    call: { to: `0x${string}`; data: `0x${string}`; value: string };
  }): Promise<GasEstimateV1 | null>;
}

const DECIMAL_V1 = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** An exact decimal of `value / 10^scale`, trailing zeros removed. */
function scaledDecimalV1(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** `gasUnits × gasPrice` in ETH and in dollars, exactly. */
export function pricedGasV1(gasUnits: bigint, price: SwapGasPriceV1): GasEstimateV1 | null {
  if (gasUnits <= 0n || price.gasPriceWei <= 0n || !DECIMAL_V1.test(price.ethUsd)) return null;
  const [whole, fraction = ''] = price.ethUsd.split('.');
  const usdScale = fraction.length;
  const usdPerEth = BigInt(`${whole}${fraction}`);
  const costWei = gasUnits * price.gasPriceWei;
  return {
    gasUnits: gasUnits.toString(),
    maxFeePerGasWei: null,
    estimatedCostNative: scaledDecimalV1(costWei, 18),
    estimatedCostUsd: scaledDecimalV1(costWei * usdPerEth, 18 + usdScale),
  };
}

interface SimulatedCallV1 {
  status?: unknown;
  gasUsed?: unknown;
}

export function createEthSimulateGasMeterV1(config: {
  /** An endpoint that serves `eth_simulateV1`. Infura does not (-32601). */
  rpcUrl: string;
  price: () => Promise<SwapGasPriceV1 | null>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): SwapGasMeterV1 {
  const rpcUrl = config.rpcUrl.trim();
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 4_000;

  async function simulate(calls: readonly Record<string, string>[]): Promise<SimulatedCallV1[] | null> {
    try {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_simulateV1',
          params: [{ blockStateCalls: [{ calls }], validation: false }, 'latest'],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const envelope = (await response.json()) as { result?: { calls?: SimulatedCallV1[] }[] };
      const answered = envelope.result?.[0]?.calls;
      return Array.isArray(answered) && answered.length === calls.length ? answered : null;
    } catch {
      return null;
    }
  }

  return {
    async measure(input) {
      if (!rpcUrl) return null;
      const from = input.walletAddress;
      const calls: Record<string, string>[] = [];
      if (input.approval) {
        calls.push({
          from,
          to: input.approval.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [input.approval.spender, BigInt(input.approval.amountAtomic)],
          }),
        });
      }
      calls.push({ from, to: input.call.to, data: input.call.data, value: `0x${BigInt(input.call.value).toString(16)}` });
      const [answered, price] = await Promise.all([simulate(calls), config.price().catch(() => null)]);
      if (!answered || !price) return null;
      // Every call must have succeeded: a reverted approval would leave the
      // swap's figure about a different execution.
      if (answered.some((call) => call.status !== '0x1')) return null;
      const swap = answered[answered.length - 1]!;
      let gasUnits: bigint;
      try {
        gasUnits = BigInt(String(swap.gasUsed));
      } catch {
        return null;
      }
      return pricedGasV1(gasUnits, price);
    },
  };
}
