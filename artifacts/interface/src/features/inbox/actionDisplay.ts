import { isProductionActionType } from '@mioagent/api-client-react';

type ActionLike = {
  status?: string;
  executionPayload?: unknown;
  metadata?: Record<string, any> | null;
};

export function parseExecutionPayload(rawPayload: unknown): Record<string, any> | null {
  if (!rawPayload) return null;
  if (typeof rawPayload === 'object') return rawPayload as Record<string, any>;
  if (typeof rawPayload !== 'string') return null;
  try {
    return JSON.parse(rawPayload) as Record<string, any>;
  } catch {
    return null;
  }
}

export function shouldShowConfirmCta(action: ActionLike): boolean {
  const meta = action.metadata || {};
  const payload = parseExecutionPayload(action.executionPayload);
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  const actionType = meta.actionType || payload?.actionType;
  const isConfirmableAction =
    meta.userConfirmable === true ||
    meta.executionStatus === 'user-confirmable' ||
    actionType === 'revoke_approval' ||
    actionType === 'limited_transfer' ||
    isProductionActionType(actionType);

  return action.status === 'pending' && calls.length > 0 && isConfirmableAction;
}

export function getStateVerifiedAllowanceZeroNotice(action: ActionLike): {
  title: string;
  label: string;
} | null {
  const proof = action.metadata?.executionProof;
  if (!proof || proof.type !== 'state_verified_allowance_zero') return null;

  return {
    title: 'Revocation effective — allowance is now 0',
    label: 'State proof only — transaction hash was not captured',
  };
}
