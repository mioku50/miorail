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

// T67C.2: submission recovery. The card and the marker helpers live here for
// the same reason the submit hook does — there is exactly ONE wallet path in
// this codebase, and recovery reuses it rather than growing a second.
export { SubmissionRecoveryCard, RECOVERY_NO_BATCH_COPY_V1, RECOVERY_REASON_COPY_V1, RECOVERY_STATUS_LABEL_V1, baseAccountActivityUrlV1 } from './src/SubmissionRecoveryCard';
export type { SubmissionRecoveryCardProps } from './src/SubmissionRecoveryCard';
export {
  browserMarkerStorageV1,
  writeRecoveryMarkerV1,
  readRecoveryMarkersV1,
  clearRecoveryMarkerV1,
  markerShouldBeClearedV1,
  MARKER_CLEARING_STATUSES_V1,
} from './src/recoveryMarker';
export type { MarkerStorageV1 } from './src/recoveryMarker';
