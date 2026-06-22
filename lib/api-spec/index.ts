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
export type ChatListResponse = z.infer<typeof schemas.ChatListResponseSchema>;

// Actions
export type ActionResponse = z.infer<typeof schemas.ActionResponseSchema>;
export type ActionsFeedResponse = z.infer<typeof schemas.ActionsFeedResponseSchema>;
export type ExecuteActionRequest = z.infer<typeof schemas.ExecuteActionRequestSchema>;
export type ExecuteActionResponse = z.infer<typeof schemas.ExecuteActionResponseSchema>;
export type DismissActionRequest = z.infer<typeof schemas.DismissActionRequestSchema>;
export type DismissActionResponse = z.infer<typeof schemas.DismissActionResponseSchema>;

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
