export type ComposerExecutionMode = 'read-only' | 'user-confirmed';

export function deriveComposerExecutionMode(execution?: {
  mode?: string;
  userConfirmedEnabled?: boolean;
}): ComposerExecutionMode {
  return execution?.mode === 'user-confirmed' && execution.userConfirmedEnabled === true
    ? 'user-confirmed'
    : 'read-only';
}

export function composerPolicyMessage(input: {
  executionMode: ComposerExecutionMode;
  policyConfigured: boolean;
}): string | null {
  if (input.executionMode === 'user-confirmed' && !input.policyConfigured) {
    return 'User-confirmed available; configure spending limits to prepare transactions.';
  }
  return null;
}
