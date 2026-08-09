import { z } from 'zod';
import * as schemas from '@mioagent/api-zod';

// Re-export schemas for convenience
export * from '@mioagent/api-zod';

// Shared
export type PaginationParams = z.infer<typeof schemas.PaginationParamsSchema>;
export type RoutePlanRequestV1 = z.infer<typeof schemas.RoutePlanRequestV1Schema>;
export type RoutePlanResponseV1 = z.infer<typeof schemas.RoutePlanResponseV1Schema>;
export type RoutePlanHttpErrorV1 = z.infer<typeof schemas.RoutePlanHttpErrorV1Schema>;
export type ClarificationV1 = z.infer<typeof schemas.ClarificationV1Schema>;
export type IntentIssueV1 = z.infer<typeof schemas.IntentIssueV1Schema>;
export type SwapPrepareRequestV1 = z.infer<typeof schemas.SwapPrepareRequestV1Schema>;
export type SwapPrepareResponseV1 = z.infer<typeof schemas.SwapPrepareResponseV1Schema>;
export type EarnCompareRequestV1 = z.infer<typeof schemas.EarnCompareRequestV1Schema>;
export type EarnCompareResponseV1 = z.infer<typeof schemas.EarnCompareResponseV1Schema>;
export type CommerceCompareRequestV1 = z.infer<typeof schemas.CommerceCompareRequestV1Schema>;
export type CommerceCompareResponseV1 = z.infer<typeof schemas.CommerceCompareResponseV1Schema>;
export type CommerceOrderCreateRequestV1 = z.infer<typeof schemas.CommerceOrderCreateRequestV1Schema>;
export type CommerceOrderCreateResponseV1 = z.infer<typeof schemas.CommerceOrderCreateResponseV1Schema>;
export type CommerceOrderStatusResponseV1 = z.infer<typeof schemas.CommerceOrderStatusResponseV1Schema>;
export type CommerceHistoryResponseV1 = z.infer<typeof schemas.CommerceHistoryResponseV1Schema>;
export type CommercePaymentPrepareRequestV1 = z.infer<typeof schemas.CommercePaymentPrepareRequestV1Schema>;
export type CommercePaymentPrepareResponseV1 = z.infer<typeof schemas.CommercePaymentPrepareResponseV1Schema>;
export type CommercePaymentApproveRequestV1 = z.infer<typeof schemas.CommercePaymentApproveRequestV1Schema>;
export type CommercePaymentApproveResponseV1 = z.infer<typeof schemas.CommercePaymentApproveResponseV1Schema>;
export type CommercePaymentSubmissionRequestV1 = z.infer<typeof schemas.CommercePaymentSubmissionRequestV1Schema>;
export type CommercePaymentSubmissionResponseV1 = z.infer<typeof schemas.CommercePaymentSubmissionResponseV1Schema>;
export type CommerceDeliveryResponseV1 = z.infer<typeof schemas.CommerceDeliveryResponseV1Schema>;
export type CommerceHistoryItemV1 = z.infer<typeof schemas.CommerceHistoryItemV1Schema>;
export type NftCompareRequestV1 = z.infer<typeof schemas.NftCompareRequestV1Schema>;
export type NftCompareResponseV1 = z.infer<typeof schemas.NftCompareResponseV1Schema>;
export type NftPrepareRequestV1 = z.infer<typeof schemas.NftPrepareRequestV1Schema>;
export type NftPrepareResponseV1 = z.infer<typeof schemas.NftPrepareResponseV1Schema>;
export type NftApproveRequestV1 = z.infer<typeof schemas.NftApproveRequestV1Schema>;
export type NftApproveResponseV1 = z.infer<typeof schemas.NftApproveResponseV1Schema>;
export type NftSubmissionRequestV1 = z.infer<typeof schemas.NftSubmissionRequestV1Schema>;
export type NftSubmissionResponseV1 = z.infer<typeof schemas.NftSubmissionResponseV1Schema>;
export type NftProofResponseV1 = z.infer<typeof schemas.NftProofResponseV1Schema>;
export type AiCompareRequestV1 = z.infer<typeof schemas.AiCompareRequestV1Schema>;
export type AiCompareResponseV1 = z.infer<typeof schemas.AiCompareResponseV1Schema>;
export type AiExecuteRequestV1 = z.infer<typeof schemas.AiExecuteRequestV1Schema>;
export type AiExecuteResponseV1 = z.infer<typeof schemas.AiExecuteResponseV1Schema>;
export type AiProofResponseV1 = z.infer<typeof schemas.AiProofResponseV1Schema>;
export type EarnPrepareRequestV1 = z.infer<typeof schemas.EarnPrepareRequestV1Schema>;
export type EarnPrepareResponseV1 = z.infer<typeof schemas.EarnPrepareResponseV1Schema>;
export type EarnBlueprintApproveRequestV1 = z.infer<typeof schemas.EarnBlueprintApproveRequestV1Schema>;
export type EarnBlueprintApproveResponseV1 = z.infer<typeof schemas.EarnBlueprintApproveResponseV1Schema>;
export type BlueprintLifecycleStateV1 = z.infer<typeof schemas.BlueprintLifecycleStateV1Schema>;
export type SwapBlueprintApproveRequestV1 = z.infer<typeof schemas.SwapBlueprintApproveRequestV1Schema>;
export type SwapBlueprintApproveResponseV1 = z.infer<typeof schemas.SwapBlueprintApproveResponseV1Schema>;
export type SwapBlueprintSubmissionRequestV1 = z.infer<typeof schemas.SwapBlueprintSubmissionRequestV1Schema>;
export type SwapBlueprintSubmissionResponseV1 = z.infer<typeof schemas.SwapBlueprintSubmissionResponseV1Schema>;
export type RouteProofReconcileRequestV1 = z.infer<typeof schemas.RouteProofReconcileRequestV1Schema>;
export type RouteProofProjectionV1 = z.infer<typeof schemas.RouteProofProjectionV1Schema>;
export type RouteProofReconcileResponseV1 = z.infer<typeof schemas.RouteProofReconcileResponseV1Schema>;
export type RouteProofGetResponseV1 = z.infer<typeof schemas.RouteProofGetResponseV1Schema>;
export type RouteHistoryItemV1 = z.infer<typeof schemas.RouteHistoryItemV1Schema>;
export type RouteHistoryRequestV1 = z.infer<typeof schemas.RouteHistoryRequestV1Schema>;
export type RouteHistoryResponseV1 = z.infer<typeof schemas.RouteHistoryResponseV1Schema>;
export type SimulateBlueprintRequestV1 = z.infer<typeof schemas.SimulateBlueprintRequestV1Schema>;
export type SimulateBlueprintResponseV1 = z.infer<typeof schemas.SimulateBlueprintResponseV1Schema>;

// T60 — Intelligence Budget + Spend Permission payments
export type IntelligenceBudgetProjectionV1 = z.infer<typeof schemas.IntelligenceBudgetProjectionV1Schema>;
export type CreateIntelligenceBudgetRequestV1 = z.infer<typeof schemas.CreateIntelligenceBudgetRequestV1Schema>;
export type UpdateIntelligenceBudgetRequestV1 = z.infer<typeof schemas.UpdateIntelligenceBudgetRequestV1Schema>;
export type RevokeIntelligenceBudgetRequestV1 = z.infer<typeof schemas.RevokeIntelligenceBudgetRequestV1Schema>;
export type IntelligenceBudgetResponseV1 = z.infer<typeof schemas.IntelligenceBudgetResponseV1Schema>;
export type PrepareSpendPermissionRequestV1 = z.infer<typeof schemas.PrepareSpendPermissionRequestV1Schema>;
export type PrepareSpendPermissionResponseV1 = z.infer<typeof schemas.PrepareSpendPermissionResponseV1Schema>;
export type ConfirmSpendPermissionRequestV1 = z.infer<typeof schemas.ConfirmSpendPermissionRequestV1Schema>;
export type ConfirmSpendPermissionResponseV1 = z.infer<typeof schemas.ConfirmSpendPermissionResponseV1Schema>;
export type SpendPermissionRefusalV1 = z.infer<typeof schemas.SpendPermissionRefusalV1Schema>;
export type SimulateWithBudgetRequestV1 = z.infer<typeof schemas.SimulateWithBudgetRequestV1Schema>;
export type SimulateWithBudgetResponseV1 = z.infer<typeof schemas.SimulateWithBudgetResponseV1Schema>;

// Auth
export type LoginRequest = z.infer<typeof schemas.LoginRequestSchema>;
export type LoginResponse = z.infer<typeof schemas.LoginResponseSchema>;
export type SessionResponse = z.infer<typeof schemas.SessionResponseSchema>;
export type WalletChallengeRequest = z.infer<typeof schemas.WalletChallengeRequestSchema>;
export type WalletChallengeResponse = z.infer<typeof schemas.WalletChallengeResponseSchema>;

// Chat
export type ChatMessageRequest = z.infer<typeof schemas.ChatMessageRequestSchema>;
export type ChatMessageResponse = z.infer<typeof schemas.ChatMessageResponseSchema>;
export type ChatHistoryResponse = z.infer<typeof schemas.ChatHistoryResponseSchema>;
export type ChatReconcileResponse = z.infer<typeof schemas.ChatReconcileResponseSchema>;
export type ChatListResponse = z.infer<typeof schemas.ChatListResponseSchema>;

// Actions
export type ActionResponse = z.infer<typeof schemas.ActionResponseSchema>;
export type ActionsFeedResponse = z.infer<typeof schemas.ActionsFeedResponseSchema>;
export type ExecuteActionRequest = z.infer<typeof schemas.ExecuteActionRequestSchema>;
export type ExecuteActionResponse = z.infer<typeof schemas.ExecuteActionResponseSchema>;
export type PrepareActionRequest = z.infer<typeof schemas.PrepareActionRequestSchema>;
export type PrepareActionResponse = z.infer<typeof schemas.PrepareActionResponseSchema>;
export type ConfirmActionRequest = z.infer<typeof schemas.ConfirmActionRequestSchema>;
export type ConfirmActionResponse = z.infer<typeof schemas.ConfirmActionResponseSchema>;
export type SecurityScreening = z.infer<typeof schemas.SecurityScreeningSchema>;
export type SimulationResult = z.infer<typeof schemas.SimulationResultSchema>;
export type DismissActionRequest = z.infer<typeof schemas.DismissActionRequestSchema>;
export type DismissActionResponse = z.infer<typeof schemas.DismissActionResponseSchema>;
export type DismissAllRecommendationsResponse = z.infer<typeof schemas.DismissAllRecommendationsResponseSchema>;
export type DeleteRecommendationsResponse = z.infer<typeof schemas.DeleteRecommendationsResponseSchema>;
export type DeleteSingleActionResponse = z.infer<typeof schemas.DeleteSingleActionResponseSchema>;
export type RegenerateRecommendationResponse = z.infer<typeof schemas.RegenerateRecommendationResponseSchema>;

// Memory
export type MemoryResponse = z.infer<typeof schemas.MemoryResponseSchema>;
export type UpdateMemoryRequest = z.infer<typeof schemas.UpdateMemoryRequestSchema>;
export type UpdateMemoryResponse = z.infer<typeof schemas.UpdateMemoryResponseSchema>;

// Settings
export type SettingsResponse = z.infer<typeof schemas.SettingsResponseSchema>;
export type UpdateSettingsRequest = z.infer<typeof schemas.UpdateSettingsRequestSchema>;
export type UpdateSettingsResponse = z.infer<typeof schemas.UpdateSettingsResponseSchema>;

// Protocols
export type Protocol = z.infer<typeof schemas.ProtocolSchema>;
export type ProtocolsListResponse = z.infer<typeof schemas.ProtocolsListResponseSchema>;
export type ToggleProtocolRequest = z.infer<typeof schemas.ToggleProtocolRequestSchema>;
export type ToggleProtocolResponse = z.infer<typeof schemas.ToggleProtocolResponseSchema>;

// Portfolio
export type PortfolioToken = z.infer<typeof schemas.PortfolioTokenSchema>;
export type PortfolioResponse = z.infer<typeof schemas.PortfolioResponseSchema>;
export type StatusResponse = z.infer<typeof schemas.StatusResponseSchema>;
export type MarketSnapshotResponseV1 = z.infer<typeof schemas.MarketSnapshotResponseV1Schema>;
export type BaseMcpToolProbeResponse = z.infer<typeof schemas.BaseMcpToolProbeResponseSchema>;
export type BaseMcpPluginCatalogueResponse = z.infer<typeof schemas.BaseMcpPluginCatalogueResponseSchema>;
export type BaseMcpConsoleRequestV1 = z.infer<typeof schemas.BaseMcpConsoleRequestV1Schema>;
export type BaseMcpConsoleResponseV1 = z.infer<typeof schemas.BaseMcpConsoleResponseV1Schema>;

// Workflows
export type Workflow = z.infer<typeof schemas.WorkflowSchema>;
export type WorkflowsListResponse = z.infer<typeof schemas.WorkflowsListResponseSchema>;
export type CreateWorkflowRequest = z.infer<typeof schemas.CreateWorkflowRequestSchema>;
export type CreateWorkflowResponse = z.infer<typeof schemas.CreateWorkflowResponseSchema>;
export type DeleteWorkflowRequest = z.infer<typeof schemas.DeleteWorkflowRequestSchema>;
export type DeleteWorkflowResponse = z.infer<typeof schemas.DeleteWorkflowResponseSchema>;

// Autonomy
export type AutonomyStateResponse = z.infer<typeof schemas.AutonomyStateResponseSchema>;
export type ConfigureAutonomyRequest = z.infer<typeof schemas.ConfigureAutonomyRequestSchema>;
export type ConfigureAutonomyResponse = z.infer<typeof schemas.ConfigureAutonomyResponseSchema>;
export type KillAutonomyResponse = z.infer<typeof schemas.KillAutonomyResponseSchema>;

// x402 Ledger & Pricing
export type X402LedgerEntry = z.infer<typeof schemas.X402LedgerEntrySchema>;
export type X402LedgerResponse = z.infer<typeof schemas.X402LedgerResponseSchema>;
export type X402PricingResponse = z.infer<typeof schemas.X402PricingResponseSchema>;
export type X402FuelResponse = z.infer<typeof schemas.X402FuelResponseSchema>;
export type X402FuelOwnerResponse = z.infer<typeof schemas.X402FuelOwnerResponseSchema>;
export type X402FuelPermissionRequest = z.infer<typeof schemas.X402FuelPermissionRequestSchema>;
export type X402FuelPermissionResponse = z.infer<typeof schemas.X402FuelPermissionResponseSchema>;

// T67E §1 — B20 Control, read-only inspection.
export type B20InspectRequestV1 = z.infer<typeof schemas.B20InspectRequestV1Schema>;
export type B20InspectResponseV1 = z.infer<typeof schemas.B20InspectResponseV1Schema>;
export type IntelligenceChargeSummaryV1 = z.infer<typeof schemas.IntelligenceChargeSummaryV1Schema>;
export type IntelligenceChargesResponseV1 = z.infer<typeof schemas.IntelligenceChargesResponseV1Schema>;
export type B20ControlWatchV1 = z.infer<typeof schemas.B20ControlWatchV1Schema>;
export type B20WatchRequestV1 = z.infer<typeof schemas.B20WatchRequestV1Schema>;
export type B20WatchResponseV1 = z.infer<typeof schemas.B20WatchResponseV1Schema>;
export type B20WatchedTokenV1 = z.infer<typeof schemas.B20WatchedTokenV1Schema>;
export type B20WatchlistEntryV1 = z.infer<typeof schemas.B20WatchlistEntryV1Schema>;
export type B20WatchlistResponseV1 = z.infer<typeof schemas.B20WatchlistResponseV1Schema>;
export type B20WatchlistAddRequestV1 = z.infer<typeof schemas.B20WatchlistAddRequestV1Schema>;
export type B20ExitCheckRequestV1 = z.infer<typeof schemas.B20ExitCheckRequestV1Schema>;
export type B20ExitCheckResponseV1 = z.infer<typeof schemas.B20ExitCheckResponseV1Schema>;
export type B20OpportunitySimulateRequestV1 = z.infer<typeof schemas.B20OpportunitySimulateRequestV1Schema>;
export type B20OpportunitySimulateResponseV1 = z.infer<typeof schemas.B20OpportunitySimulateResponseV1Schema>;
export type B20EntryPrepareRequestV1 = z.infer<typeof schemas.B20EntryPrepareRequestV1Schema>;
export type B20EntryPrepareResponseV1 = z.infer<typeof schemas.B20EntryPrepareResponseV1Schema>;
export type B20EntryReviewV1 = z.infer<typeof schemas.B20EntryReviewV1Schema>;
export type B20EntryPlanResponseV1 = z.infer<typeof schemas.B20EntryPlanResponseV1Schema>;
export type B20EntryBeginSubmissionResponseV1 = z.infer<typeof schemas.B20EntryBeginSubmissionResponseV1Schema>;
export type B20EntryStatusResponseV1 = z.infer<typeof schemas.B20EntryStatusResponseV1Schema>;
export type B20EntryOutcomeV1 = z.infer<typeof schemas.B20EntryOutcomeV1Schema>;
export type B20EntryUiStateV1 = z.infer<typeof schemas.B20EntryUiStateV1Schema>;
