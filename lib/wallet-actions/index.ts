// T19: shared user-confirmed wallet action flow. The server prepares unsigned
// EIP-5792 payloads and records results; these helpers drive the client side
// (Base Account wallet_sendCalls + getCallsStatus polling + builder-code
// attribution) for both the web interface and the miniapp.

export { builderCodeToDataSuffix } from './src/attribution';
export { useWalletConfirmAction, CallsStatusPoller, normalizeCallValue, normalizeCall, sanitizeBigInts } from './src/useWalletConfirmAction';
export type { ConfirmFlowStatus, UseWalletConfirmActionResult, UseWalletConfirmActionArgs, CallsStatusPollerProps } from './src/useWalletConfirmAction';
export { WalletConfirmButton } from './src/WalletConfirmButton';
export type { WalletConfirmButtonProps, WalletConfirmAction } from './src/WalletConfirmButton';

// T57: approved-blueprint submission flow (server approve → Base Account
// wallet → idempotent submission record). Shares CallsStatusPoller,
// normalizeCall, and builder-code attribution with the T19 flow.
export {
  useSubmitApprovedBlueprint,
  isWalletRejectionError,
  blueprintSubmitPreflight,
  transactionHashesFromReceipts,
  normalizeWalletReceipts,
  walletQuantityToAtomic,
} from './src/useSubmitApprovedBlueprint';
export type {
  BlueprintSubmitStatus,
  ApprovedWalletPayload,
  BlueprintPreflightInput,
  UseSubmitApprovedBlueprintArgs,
  UseSubmitApprovedBlueprintResult,
} from './src/useSubmitApprovedBlueprint';
export {
  BlueprintSubmitButton,
  blueprintSubmitLabel,
  blueprintSubmitDisabledReason,
} from './src/BlueprintSubmitButton';
export type { BlueprintSubmitButtonProps } from './src/BlueprintSubmitButton';

// T62.1: the shared Earn deposit execution flow (select → prepare → review →
// wallet submit → Route Proof) used identically by web and miniapp.
export { EarnDepositFlow, formatEarnAmountForDisplayV1, earnProofStatusMessageV1 } from './src/EarnDepositFlow';
export type { EarnDepositFlowProps, EarnProofState } from './src/EarnDepositFlow';
