// T48a: pure diagnostics snapshot for the BaseApp/operator diagnostics panel.
// Kept separate from rendering so it is unit-testable without wagmi/DOM.
// `capabilities` is the EIP-5792 `wallet_getCapabilities` result for the
// currently connected chain (best-effort — undefined/null when the wallet
// doesn't support it or the probe hasn't resolved yet; never throws).

export interface BaseAppDiagnosticsInput {
  injectedProviderDetected: boolean;
  walletAddress?: string | null;
  chainId?: number | null;
  sessionAuthenticated: boolean;
  isBaseAppEnvironment: boolean;
  capabilities?: Record<string, unknown> | null;
}

export interface BaseAppDiagnostics {
  injectedProviderDetected: boolean;
  walletAddress: string | null;
  chainId: number | null;
  sessionAuthenticated: boolean;
  isBaseAppEnvironment: boolean;
  walletCapabilities: Record<string, unknown> | null;
  /** wallet_sendCalls (EIP-5792 atomic batch) is supported by the connected wallet. */
  sendCallsSupported: boolean;
}

function detectSendCallsSupport(capabilities?: Record<string, unknown> | null): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;

  // Current EIP-5792 shape: capabilities.atomic.status === 'supported' | 'ready'.
  const atomic = capabilities.atomic;
  if (atomic && typeof atomic === 'object' && 'status' in atomic) {
    const status = (atomic as { status?: unknown }).status;
    if (status === 'supported' || status === 'ready') return true;
  }

  // Legacy/alternate shape some wallets still report: atomicBatch.supported.
  const atomicBatch = capabilities.atomicBatch;
  if (atomicBatch && typeof atomicBatch === 'object' && (atomicBatch as { supported?: unknown }).supported === true) {
    return true;
  }

  return false;
}

export function collectBaseAppDiagnostics(input: BaseAppDiagnosticsInput): BaseAppDiagnostics {
  return {
    injectedProviderDetected: input.injectedProviderDetected,
    walletAddress: input.walletAddress || null,
    chainId: input.chainId ?? null,
    sessionAuthenticated: input.sessionAuthenticated,
    isBaseAppEnvironment: input.isBaseAppEnvironment,
    walletCapabilities: input.capabilities ?? null,
    sendCallsSupported: detectSendCallsSupport(input.capabilities),
  };
}
