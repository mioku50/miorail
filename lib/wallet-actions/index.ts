// T19: shared user-confirmed wallet action flow. The server prepares unsigned
// EIP-5792 payloads and records results; these helpers drive the client side
// (Base Account wallet_sendCalls + getCallsStatus polling + builder-code
// attribution) for both the web interface and the miniapp.

export { builderCodeToDataSuffix } from './src/attribution';
export { useWalletConfirmAction, CallsStatusPoller, normalizeCallValue, normalizeCall, sanitizeBigInts } from './src/useWalletConfirmAction';
export type { ConfirmFlowStatus, UseWalletConfirmActionResult, UseWalletConfirmActionArgs, CallsStatusPollerProps } from './src/useWalletConfirmAction';
export { WalletConfirmButton } from './src/WalletConfirmButton';
export type { WalletConfirmButtonProps, WalletConfirmAction } from './src/WalletConfirmButton';
