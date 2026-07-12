import type { QueryClient } from '@tanstack/react-query';
import { resetTenantUiState } from './state';

export function clearTenantClientState(queryClient: QueryClient): void {
  queryClient.clear();
  resetTenantUiState();
}
