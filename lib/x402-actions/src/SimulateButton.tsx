import { useSimulationPayment, type UseSimulationPaymentOptions } from './useSimulationPayment.js';
import type { PaidActionState } from './paidFetch.js';

export interface SimulateButtonProps extends UseSimulationPaymentOptions {
  /** e.g. "0.01 USDC" — shown pre-click. Comes from the /swap/prepare
   * response's simulationPriceUsdc (decision 11), never invented client-side. */
  priceLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * T59 decision 10(c) — the exact label set: "Preparing payment / Confirm in
 * Base Account / Payment settled / Running simulation / Simulation passed /
 * Simulation reverted / Paid, but service failed", mapped from
 * PaidActionState (the x402 payment flow) plus the LAST response's
 * outcome/simulation.status once the flow reaches a terminal paid state.
 */
export function simulateButtonLabel(input: {
  state: PaidActionState;
  outcome: string | null;
  simulationStatus: string | null;
  priceLabel: string;
  isConnected: boolean;
  isWrongChain: boolean;
}): string {
  if (!input.isConnected) return 'Connect wallet first';
  if (input.isWrongChain) return 'Switch to Base';

  switch (input.state) {
    case 'idle':
      return `Pay & simulate (${input.priceLabel})`;
    case 'preparing_payment':
      return 'Preparing payment';
    case 'awaiting_wallet_confirmation':
    case 'awaiting_wallet':
      return 'Confirm in Base Account';
    case 'submitted':
    case 'settling_payment':
    case 'settling':
      return 'Payment settled';
    case 'running_action':
      return 'Running simulation';
    case 'succeeded':
    case 'settled':
    case 'settled_degraded':
      if (input.outcome === 'paid_service_failed') return 'Paid, but service failed';
      if (input.outcome === 'invalid_response') return 'Simulation failed';
      if (input.simulationStatus === 'failed') return 'Simulation reverted';
      if (input.simulationStatus === 'passed') return 'Simulation passed';
      return 'Simulation complete';
    case 'rejected':
      return 'Payment rejected - retry';
    case 'cancelled':
      return 'Payment cancelled - retry';
    case 'failed':
      return 'Payment failed - retry';
    case 'insufficient_funds':
      return 'Insufficient USDC on Base';
    case 'unsupported_wallet':
      return 'Connect wallet first';
    case 'settlement_failed':
      return 'Payment settlement failed';
    default:
      return `Pay & simulate (${input.priceLabel})`;
  }
}

export function SimulateButton({ priceLabel, disabled, className, ...options }: SimulateButtonProps) {
  const { state, outcome, response, error, isBusy, isConnected, isWrongChain, run } = useSimulationPayment(options);
  const simulationStatus =
    response && (response.outcome === 'simulated' || response.outcome === 'cached')
      ? response.simulation.status
      : null;

  const label = simulateButtonLabel({
    state,
    outcome,
    simulationStatus,
    priceLabel,
    isConnected,
    isWrongChain,
  });

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={disabled || isBusy}
        className={className}
        aria-busy={isBusy}
      >
        {label}
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}
