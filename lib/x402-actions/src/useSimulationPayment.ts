import { useCallback, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { SimulateBlueprintResponseV1Schema } from '@mioagent/api-zod';
import {
  PaidActionError,
  runX402PaidFetch,
  type PaidActionResult,
  type PaidActionState,
} from './paidFetch.js';

export type SimulateBlueprintResponseV1 = z.infer<typeof SimulateBlueprintResponseV1Schema>;

export interface SimulateBlueprintRequestBodyV1 {
  routeRunId: string;
  walletAddress: string;
  blueprintHash: string;
  idempotencyKey: string;
}

export interface UseSimulationPaymentOptions {
  routeRunId: string;
  blueprintId: string;
  blueprintHash: string;
  expectedChainId?: number;
  /** Test-only escape hatch — production callers never set this. */
  fetchImpl?: typeof fetch;
  onSuccess?: (response: SimulateBlueprintResponseV1, result: PaidActionResult) => void | Promise<void>;
  onFailure?: (error: PaidActionError) => void;
}

export interface UseSimulationPaymentResult {
  state: PaidActionState;
  outcome: SimulateBlueprintResponseV1['outcome'] | null;
  response: SimulateBlueprintResponseV1 | null;
  error: string | null;
  isBusy: boolean;
  isConnected: boolean;
  isWrongChain: boolean;
  /** Deterministic per (blueprintHash, connected wallet) — a re-click or a
   * component remount before the request settles sends the EXACT SAME key,
   * so a retry never risks a second x402 charge. */
  idempotencyKey: string;
  run: () => Promise<void>;
}

const BUSY_STATES: readonly PaidActionState[] = [
  'preparing_payment',
  'awaiting_wallet_confirmation',
  'awaiting_wallet',
  'submitted',
  'settling_payment',
  'settling',
  'running_action',
];

/**
 * T59 decision 10 — deterministic, NOT cryptographically-hashed
 * idempotencyKey: blueprintHash already carries 256 bits of entropy, so a
 * truncated slice plus a wallet-address suffix is more than enough
 * collision resistance for "the same blueprint, the same wallet, retried"
 * — and it stays synchronous (no async Web Crypto digest) so it's available
 * on the very first render, before any click.
 */
export function deterministicSimulationIdempotencyKeyV1(blueprintHash: string, walletAddress: string): string {
  const hashPart = blueprintHash.replace(/^0x/i, '').slice(0, 40).toLowerCase();
  const walletPart = walletAddress.replace(/^0x/i, '').slice(-8).toLowerCase();
  return `sim-${hashPart}-${walletPart}`;
}

export function useSimulationPayment(options: UseSimulationPaymentOptions): UseSimulationPaymentResult {
  const { routeRunId, blueprintId, blueprintHash, expectedChainId = 8453, fetchImpl, onSuccess, onFailure } = options;
  const [state, setState] = useState<PaidActionState>('idle');
  const [outcome, setOutcome] = useState<SimulateBlueprintResponseV1['outcome'] | null>(null);
  const [response, setResponse] = useState<SimulateBlueprintResponseV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isConnected, address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();
  // Ref-guard (decision 10): a second click while a request is already
  // in-flight is a no-op, not a second x402 challenge.
  const inFlightRef = useRef(false);

  const isBusy = BUSY_STATES.includes(state);
  const isWrongChain = Boolean(isConnected && chainId !== expectedChainId);
  const idempotencyKey = useMemo(
    () => (address ? deterministicSimulationIdempotencyKeyV1(blueprintHash, address) : ''),
    [address, blueprintHash],
  );

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!isConnected || !address) {
      setState('unsupported_wallet');
      setError('Connect wallet first');
      return;
    }
    if (isWrongChain) {
      switchChain?.({ chainId: expectedChainId });
      return;
    }
    inFlightRef.current = true;
    setError(null);
    try {
      const requestBody: SimulateBlueprintRequestBodyV1 = {
        routeRunId,
        walletAddress: address,
        blueprintHash,
        idempotencyKey,
      };
      // Exactly ONE runX402PaidFetch call per run() invocation — no
      // calldata, no chat history, no tenantId in the body: only the four
      // whitelisted fields above.
      const result = await runX402PaidFetch({
        route: `/api/route-intelligence/blueprints/${blueprintId}/simulate`,
        walletClient,
        expectedChainId,
        fetchImpl,
        runId: idempotencyKey,
        onState: setState,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
        },
      });

      const parsed = SimulateBlueprintResponseV1Schema.safeParse(result.body);
      if (!parsed.success) {
        const invalid = new PaidActionError('failed', 'Simulate response failed schema validation', undefined, 'invalid_response_schema');
        setState('failed');
        setOutcome(null);
        setResponse(null);
        setError(invalid.message);
        onFailure?.(invalid);
        return;
      }
      setOutcome(parsed.data.outcome);
      setResponse(parsed.data);
      await onSuccess?.(parsed.data, result);
    } catch (rawError) {
      const paidError = rawError instanceof PaidActionError
        ? rawError
        : new PaidActionError('failed', rawError instanceof Error ? rawError.message : 'Payment failed');
      setState(paidError.state);
      setError(paidError.message);
      onFailure?.(paidError);
    } finally {
      inFlightRef.current = false;
    }
  }, [address, blueprintHash, blueprintId, expectedChainId, fetchImpl, idempotencyKey, isConnected, isWrongChain, onFailure, onSuccess, routeRunId, switchChain, walletClient]);

  return { state, outcome, response, error, isBusy, isConnected, isWrongChain, idempotencyKey, run };
}
