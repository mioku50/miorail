export interface SecurityAnalysisShape {
  portfolioSnapshot?: {
    securityCheckedTokenCount?: number | null;
  } | null;
  securityProvider?: {
    status?: string | null;
    coverage?: string | null;
    failureReason?: string | null;
  } | null;
}

export interface SecurityCoverageUi {
  state: 'complete' | 'partial' | 'unavailable';
  label: string;
  reason: string;
  retryable: boolean;
}

function sanitizedFailureReason(value: string | null | undefined, status: string): string {
  const normalized = (value || '').toLowerCase();
  if (/rate|429|budget|quota|limit/.test(normalized)) {
    return 'The contract check service is temporarily rate-limited.';
  }
  if (/auth|unauthor|forbidden|401|403/.test(normalized)) {
    return 'The contract check service authentication is unavailable.';
  }
  if (/timeout|timed out|network|fetch|unreachable|econn|enotfound/.test(normalized)) {
    return 'The contract check service is temporarily unreachable.';
  }
  if (status === 'disabled' || status === 'missing') {
    return 'Contract checks are not configured for this scan.';
  }
  return 'The contract check service did not return usable token-security verdicts.';
}

// Provider failures may include request details. Keep those details server-side
// and expose only fixed, actionable categories in the product UI.
export function securityCoverageUi(analysis?: SecurityAnalysisShape | null): SecurityCoverageUi {
  const checked = Math.max(0, Number(analysis?.portfolioSnapshot?.securityCheckedTokenCount || 0));
  const status = analysis?.securityProvider?.status || 'missing';
  const declaredCoverage = analysis?.securityProvider?.coverage;

  if (checked === 0 || declaredCoverage === 'unavailable' || ['failed', 'missing', 'disabled'].includes(status)) {
    return {
      state: 'unavailable',
      label: 'Contract checks unavailable',
      reason: sanitizedFailureReason(analysis?.securityProvider?.failureReason, status),
      retryable: status === 'failed' || status === 'connected' || status === 'partial',
    };
  }

  if (declaredCoverage === 'partial' || status === 'partial') {
    return {
      state: 'partial',
      label: 'Contract checks incomplete',
      reason: `Only ${checked} token contract${checked === 1 ? '' : 's'} returned a usable verdict.`,
      retryable: true,
    };
  }

  return {
    state: 'complete',
    label: 'Contract checks complete',
    reason: `${checked} usable token-security verdict${checked === 1 ? '' : 's'} returned.`,
    retryable: false,
  };
}
