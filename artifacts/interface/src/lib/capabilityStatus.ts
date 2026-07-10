export type CapabilityState = 'active' | 'limited' | 'off';

const ACTIVE = new Set(['connected', 'configured', 'ok', 'live', 'ready', 'active', 'settled']);
const LIMITED = new Set([
  'partial',
  'stale',
  'cached',
  'degraded',
  'simulated',
  'warning',
  'rate_limited',
  'budget_exhausted',
  'temporarily_unavailable',
  'auth_or_budget_issue',
  'needs_reauth',
  'needs_auth',
  'facilitator_auth_required',
  'facilitator_auth_invalid',
  'facilitator_rate_limited',
  'facilitator_unreachable',
  'unsupported_network_for_settlement',
]);

export function capabilityState(status?: string | null): CapabilityState {
  const normalized = status?.toLowerCase();
  if (normalized && ACTIVE.has(normalized)) return 'active';
  if (normalized && LIMITED.has(normalized)) return 'limited';
  return 'off';
}

export function capabilityLabel(state: CapabilityState): 'Active' | 'Limited' | 'Off' {
  if (state === 'active') return 'Active';
  if (state === 'limited') return 'Limited';
  return 'Off';
}

export function capabilityTone(state: CapabilityState): string {
  if (state === 'active') return 'text-ok bg-ok-soft border-ok/25';
  if (state === 'limited') return 'text-warn bg-warn-soft border-warn/25';
  return 'text-ink-3 bg-panel-2 border-line';
}

export function capabilityDot(state: CapabilityState): string {
  if (state === 'active') return 'bg-ok shadow-[0_0_6px_rgba(61,220,151,0.55)]';
  if (state === 'limited') return 'bg-warn shadow-[0_0_6px_rgba(255,180,84,0.45)]';
  return 'bg-ink-3';
}

export function x402CapabilityState(input?: { settleReady?: boolean; status?: string | null }): CapabilityState {
  if (input?.settleReady) return 'active';
  return capabilityState(input?.status);
}
