export interface SavedAutonomyPolicyShape {
  source?: string | null;
  status?: string | null;
  dailyLimitUsdc?: string | null;
  maxPerActionUsdc?: string | null;
  ttlSeconds?: number | null;
  whitelist?: string[] | null;
  mainnetOptIn?: boolean | null;
  walletAddress?: string | null;
  expiresAt?: string | null;
  blockedReasons?: string[] | null;
  executionReady?: boolean | null;
  killSwitch?: boolean | null;
}

export interface AutonomyStateShape {
  sessionKey?: SavedAutonomyPolicyShape | null;
}

export interface SavedPolicyForm {
  dailyLimit: string;
  maxPerAction: string;
  ttlHours: string;
  whitelistAddr: string;
  mainnetOptIn: boolean;
  acknowledgeMainnetRisk: boolean;
  hydrationKey: string;
}

export function savedPolicyForm(state?: AutonomyStateShape | null): SavedPolicyForm | null {
  const policy = state?.sessionKey;
  if (!policy || policy.source !== 'database' || policy.status !== 'configured') return null;
  const ttlHours = Math.max(0, Number(policy.ttlSeconds || 0) / 3600);
  const normalizedTtl = Number.isInteger(ttlHours)
    ? String(ttlHours)
    : String(Math.round(ttlHours * 100) / 100);
  const mainnetOptIn = policy.mainnetOptIn === true;
  return {
    dailyLimit: String(policy.dailyLimitUsdc || ''),
    maxPerAction: String(policy.maxPerActionUsdc || ''),
    ttlHours: normalizedTtl,
    whitelistAddr: (policy.whitelist || []).join('\n'),
    mainnetOptIn,
    // A persisted mainnet opt-in could only have been saved after explicit
    // acknowledgement, so a hydrated form should not contradict that state.
    acknowledgeMainnetRisk: mainnetOptIn,
    hydrationKey: [
      policy.walletAddress || '',
      policy.expiresAt || '',
      policy.dailyLimitUsdc || '',
      policy.maxPerActionUsdc || '',
      String(policy.ttlSeconds || ''),
      (policy.whitelist || []).join(','),
      String(mainnetOptIn),
    ].join('|'),
  };
}

export function visibleAutonomyBlockedReasons(state?: AutonomyStateShape | null): string[] {
  const policy = state?.sessionKey;
  const reasons = [...(policy?.blockedReasons || [])];
  if (policy?.source === 'database' && policy.status === 'configured') {
    return reasons.filter((reason) => {
      if (reason === 'autonomy_policy_missing') return false;
      if (reason === 'mainnet_opt_in_required' && policy.mainnetOptIn) return false;
      return true;
    });
  }
  return reasons;
}

export function cockpitAutonomyPresentation(
  state?: AutonomyStateShape | null,
  options: { stale?: boolean; expired?: boolean } = {},
): { capability: 'active' | 'limited' | 'off'; label: string; readOnlyActive: boolean } {
  const policy = state?.sessionKey;
  const unavailable = policy?.killSwitch === true
    || policy?.status === 'revoked'
    || policy?.status === 'inactive';
  if (unavailable) return { capability: 'off', label: 'Off', readOnlyActive: false };
  if (options.stale || options.expired) {
    return { capability: 'limited', label: 'Limited', readOnlyActive: false };
  }
  if (policy?.executionReady === true) {
    return { capability: 'active', label: 'Active', readOnlyActive: false };
  }
  if (policy?.status === 'configured') {
    return { capability: 'limited', label: 'Read-only active', readOnlyActive: true };
  }
  return { capability: 'off', label: 'Off', readOnlyActive: false };
}
