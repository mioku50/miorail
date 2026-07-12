// T44: capability-level network label, decoupled from autonomy/policy state.
// "Read-only" here means the SERVER cannot prepare user-confirmed transactions
// (execution.mode === 'read-only'), NOT that the user's policy is missing —
// policy readiness is a separate badge (cockpitAutonomyPresentation).
// Pure function so it is unit-testable without React or import.meta.env.

export type NetworkExecutionMode = 'read-only' | 'user-confirmed' | 'server-execution';

export interface NetworkLabelInput {
  /** Runtime chainEnv from /api/status, falling back to the build-time env. */
  chainEnv: string;
  executionMode?: NetworkExecutionMode;
  userConfirmedEnabled?: boolean;
  /** Autonomy policy readiness — used ONLY for the strict action gate. */
  executionReady?: boolean;
}

export interface NetworkLabelState {
  label: string;
  /** Capability-level: server execution mode is read-only. */
  readOnly: boolean;
  /**
   * Strict action gate (the old readOnly semantics inverted): user-confirmed
   * mode is on AND the saved policy reports executionReady. Consumers that
   * gate ACTIONS must use this, never `readOnly`.
   */
  executionUnlocked: boolean;
}

export function deriveNetworkLabel(input: NetworkLabelInput): NetworkLabelState {
  const isSepolia = input.chainEnv === 'sepolia';
  // Until /api/status responds there is no execution mode; fail conservative
  // (mainnet renders read-only, sepolia renders its testnet label).
  const readOnly = input.executionMode !== undefined
    ? input.executionMode === 'read-only'
    : !isSepolia;
  const userConfirmed = input.executionMode === 'user-confirmed' && input.userConfirmedEnabled === true;
  const label = isSepolia
    ? 'Base Sepolia'
    : userConfirmed
      ? 'Base Mainnet · User-confirmed'
      : 'Base Mainnet · Read-only';
  return {
    label,
    readOnly,
    executionUnlocked: userConfirmed && input.executionReady === true,
  };
}
