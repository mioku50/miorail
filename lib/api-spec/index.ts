import { z } from 'zod';
import * as schemas from '@mioagent/api-zod';

// Re-export schemas for convenience
export * from '@mioagent/api-zod';

// Shared
export type PaginationParams = z.infer<typeof schemas.PaginationParamsSchema>;

// Auth
export type LoginRequest = z.infer<typeof schemas.LoginRequestSchema>;
export type LoginResponse = z.infer<typeof schemas.LoginResponseSchema>;
export type SessionResponse = z.infer<typeof schemas.SessionResponseSchema>;

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
export type BaseMcpToolProbeResponse = z.infer<typeof schemas.BaseMcpToolProbeResponseSchema>;

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
