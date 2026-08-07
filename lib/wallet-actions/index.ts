// T19: shared user-confirmed wallet action flow. The server prepares unsigned
// EIP-5792 payloads and records results; these helpers drive the client side
// (Base Account wallet_sendCalls + getCallsStatus polling + builder-code
// attribution) for both the web interface and the miniapp.

export {
  BUILDER_ATTRIBUTION_LABELS_V1,
  builderAttributionOutcomeV1,
  builderCodeAdviceV1,
  builderCodeForSurfaceV1,
  builderCodeFromEnvV1,
  builderCodeToDataSuffix,
  dataSuffixSupportV1,
  resolveBuilderCodeV1,
} from './src/attribution';
export type {
  BuilderAttributionOutcomeV1,
  BuilderAttributionStatusV1,
  BuilderCodeEnvV1,
  BuilderCodeResolutionV1,
} from './src/attribution';
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
export { SubmissionRecoveryRail } from './src/SubmissionRecoveryRail';
export type { SubmissionRecoveryRailProps } from './src/SubmissionRecoveryRail';
export {
  browserMarkerStorageV1,
  writeRecoveryMarkerV1,
  readRecoveryMarkersV1,
  clearRecoveryMarkerV1,
  markerShouldBeClearedV1,
  MARKER_CLEARING_STATUSES_V1,
} from './src/recoveryMarker';
export type { MarkerStorageV1 } from './src/recoveryMarker';

// T71: Base Spend Permission onboarding. The server says what to request, the
// user's Base Account signs it, and the server verifies it on chain before any
// budget exists. Miorail never signs.
export {
  useSpendPermissionOnboarding,
  SPEND_PERMISSION_FLOW_COPY_V1,
} from './src/useSpendPermissionOnboarding';
export { useSpendPermissionGrant } from './src/useSpendPermissionGrant';
export type { SpendPermissionGrantV1 } from './src/useSpendPermissionGrant';
export type {
  SpendPermissionFlowStatusV1,
  PreparedPermissionV1,
  WalletGrantedPermissionV1,
  ConfirmResultV1,
  UseSpendPermissionOnboardingArgs,
  UseSpendPermissionOnboardingResultV1,
} from './src/useSpendPermissionOnboarding';
