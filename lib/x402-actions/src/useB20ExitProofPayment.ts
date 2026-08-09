import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { B20OpportunitySimulateResponseV1Schema } from '@mioagent/api-zod';
import {
  PaidActionError,
  runX402PaidFetch,
  type PaidActionResult,
  type PaidActionState,
} from './paidFetch.js';

// ---------------------------------------------------------------------------
// Paying for the B20 exit proof.
//
// The client half of moving the charge off swap simulation. The server now
// prices `/b20/opportunity/simulate` — the sequential simulation of both legs
// against one state, the only operation that can produce `qualified` — and
// this is what answers its 402.
//
// A near-twin of `useSimulationPayment` rather than a generalisation of it.
// The two differ in the ONE place that matters: what makes a retry the same
// request. A swap simulation is identified by its blueprint hash, which is
// already a commitment to exact calldata; a B20 exit proof is identified by
// the token AND the profile, because proving 100 USDC of a token says nothing
// about 500 and must not be served from the same paid answer. Folding both
// into one hook would mean one idempotency rule serving two different
// definitions of "the same question", and the failure mode is a user paying
// twice — or worse, paying once and being shown the wrong proof.
// ---------------------------------------------------------------------------

export type B20ExitProofResponseV1 = z.infer<typeof B20OpportunitySimulateResponseV1Schema>;

export interface B20ExitProofRequestV1 {
  tokenAddress: string;
  positionAtomic: string;
  maxRoundTripBps: number;
  maxExitSlippageBps: number;
}

export interface UseB20ExitProofPaymentOptions {
  expectedChainId?: number;
  /** Test-only escape hatch — production callers never set this. */
  fetchImpl?: typeof fetch;
  onSuccess?: (body: B20ExitProofResponseV1, result: PaidActionResult) => void | Promise<void>;
  onFailure?: (error: PaidActionError) => void;
}

export interface UseB20ExitProofPaymentResult {
  state: PaidActionState;
  response: B20ExitProofResponseV1 | null;
  error: string | null;
  isBusy: boolean;
  isConnected: boolean;
  isWrongChain: boolean;
  /** The key the last run used. Deterministic per (token, profile, wallet):
   * a re-click or a remount before the request settles sends the same key, so
   * a retry never risks a second charge — and a DIFFERENT position produces a
   * different key, so it is never answered from the first one's payment. */
  idempotencyKey: string;
  /** The request is passed HERE rather than to the hook, because the token is
   * chosen by a click. Taking it at construction would mean the click and the
   * request could disagree by one render — and the thing that disagrees is
   * which token somebody paid to have proven. */
  run: (request: B20ExitProofRequestV1) => Promise<void>;
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
 * The identity of a paid exit proof.
 *
 * Every field of the profile is in it. A proof for one position size is not an
 * answer about another, and a key that ignored the size would let a cheap
 * question be answered with an expensive one's receipt — or the reverse.
 */
export function deterministicB20ExitProofKeyV1(
  request: B20ExitProofRequestV1,
  walletAddress: string,
): string {
  const token = request.tokenAddress.replace(/^0x/i, '').slice(0, 40).toLowerCase();
  const walletPart = walletAddress.replace(/^0x/i, '').slice(-8).toLowerCase();
  return [
    'b20exit',
    token,
    request.positionAtomic,
    String(request.maxRoundTripBps),
    String(request.maxExitSlippageBps),
    walletPart,
  ].join('-');
}

export function useB20ExitProofPayment(
  options: UseB20ExitProofPaymentOptions,
): UseB20ExitProofPaymentResult {
  const { expectedChainId = 8453, fetchImpl, onSuccess, onFailure } = options;
  const [state, setState] = useState<PaidActionState>('idle');
  const [response, setResponse] = useState<B20ExitProofResponseV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isConnected, address, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChain } = useSwitchChain();
  // A second click while a request is in flight is a no-op, not a second
  // x402 challenge.
  const inFlightRef = useRef(false);

  const isBusy = BUSY_STATES.includes(state);
  const isWrongChain = Boolean(isConnected && chainId !== expectedChainId);
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const run = useCallback(async (request: B20ExitProofRequestV1) => {
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
    const runKey = deterministicB20ExitProofKeyV1(request, address);
    setIdempotencyKey(runKey);
    try {
      // The token and the profile, and nothing else. No wallet balance, no
      // position the user actually holds: the server prices a question about
      // a token, and it has no business learning how much of it anyone owns.
      const result = await runX402PaidFetch({
        route: '/api/route-intelligence/b20/opportunity/simulate',
        walletClient,
        expectedChainId,
        fetchImpl,
        runId: runKey,
        onState: setState,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chainId: expectedChainId,
            tokenAddress: request.tokenAddress,
            positionAtomic: request.positionAtomic,
            maxRoundTripBps: request.maxRoundTripBps,
            maxExitSlippageBps: request.maxExitSlippageBps,
          }),
        },
      });
      // Validated here, where the contract lives. A body that does not match
      // must not become a verdict about somebody's token merely because it
      // arrived over a paid channel — and the caller should not have to know
      // the schema to be safe from that.
      const parsed = B20OpportunitySimulateResponseV1Schema.safeParse(result.body);
      if (!parsed.success) {
        const invalid = new PaidActionError(
          'failed',
          'The exit proof response failed schema validation',
          undefined,
          'invalid_response_schema',
        );
        setState('failed');
        setResponse(null);
        setError(invalid.message);
        onFailure?.(invalid);
        return;
      }
      setResponse(parsed.data);
      await onSuccess?.(parsed.data, result);
    } catch (cause) {
      const failure =
        cause instanceof PaidActionError
          ? cause
          : new PaidActionError('failed', 'The exit proof could not be completed');
      setState(failure.state === 'idle' ? 'failed' : failure.state);
      // Never the raw cause: a transport error can carry an endpoint, and an
      // endpoint can carry a key.
      setError(failure.message);
      onFailure?.(failure);
    } finally {
      inFlightRef.current = false;
    }
  }, [
    address,
    expectedChainId,
    fetchImpl,
    isConnected,
    isWrongChain,
    onFailure,
    onSuccess,
    switchChain,
    walletClient,
  ]);

  return {
    state,
    response,
    error,
    isBusy,
    isConnected: Boolean(isConnected),
    isWrongChain,
    idempotencyKey,
    run,
  };
}
