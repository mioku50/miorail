// Ported verbatim from App.tsx (F2 parity). F3 will rewire these to StateBadge.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { StateKind } from '@mioagent/ui';

export function formatRiskProvider(statusData: any, pendingLabel = 'Checking...') {
  if (!statusData) return pendingLabel;
  if (statusData.risk.status === 'connected') return statusData.risk.provider === 'goplus' ? 'GoPlus connected' : 'Connected';
  if (statusData.risk.status === 'partial') return statusData.risk.provider === 'goplus' ? 'GoPlus partial' : 'Partial';
  if (statusData.risk.status === 'failed') return statusData.risk.provider === 'goplus' ? 'GoPlus failed' : 'Failed';
  if (statusData.risk.status === 'disabled') return 'Disabled by config';
  return 'Missing';
}

export function baseMcpState(status?: string): StateKind {
  if (status === 'connected') return 'live';
  if (status === 'degraded' || status === 'needs_reauth' || status === 'needs_auth') return 'stale';
  if (status === 'disabled') return 'disabled';
  if (status === 'unreachable' || status === 'unsupported') return 'failed';
  return 'missing';
}

export function formatBaseMcpStatus(baseMcp?: any, pendingLabel = 'Checking...') {
  if (!baseMcp) return pendingLabel;
  if (baseMcp.readiness === 'tools_available') return `${baseMcp.toolsCount ?? baseMcp.capabilities?.toolsCount ?? 0} tools available`;
  if (baseMcp.readiness === 'oauth_connected') return 'OAuth connected · tools unavailable';
  if (baseMcp.readiness === 'configured') return baseMcp.auth?.connected ? 'OAuth connected' : 'configured · connect required';
  if (baseMcp.readiness === 'not_configured') return 'not configured';
  if (baseMcp.status === 'connected') return baseMcp.endpointHost ? `connected (${baseMcp.endpointHost})` : 'connected';
  if (baseMcp.status === 'needs_reauth' || baseMcp.status === 'needs_auth') return 'needs auth';
  if (baseMcp.status === 'degraded') return baseMcp.errorCode === 'rate_limited' ? 'degraded (rate limited)' : 'degraded';
  if (baseMcp.status === 'unreachable') return 'unreachable';
  if (baseMcp.status === 'unsupported') return 'unsupported';
  if (baseMcp.status === 'disabled') return 'disabled';
  return 'missing';
}

export function baseMcpHint(baseMcp?: any): string | null {
  if (!baseMcp) return null;
  if (baseMcp.readiness === 'oauth_connected' && !baseMcp.usable) return 'OAuth is connected, but no usable tools were verified. Reconnect Base MCP and retry.';
  if (baseMcp.readiness === 'degraded') return `Base MCP is degraded${baseMcp.errorCode ? ` (${baseMcp.errorCode})` : ''}.`;
  if (baseMcp.status === 'needs_reauth' || baseMcp.status === 'needs_auth') return 'Optional: connect Base MCP to enable portfolio, send and swap via Base.';
  if (baseMcp.status !== 'missing') return null;
  if (baseMcp.configured && baseMcp.enabled) return 'Optional: connect Base MCP to enable portfolio, send and swap via Base.';
  return 'Base MCP is optional. Configure BASE_MCP_SERVER_URL to enable tool status.';
}

export function baseMcpNeedsAuth(baseMcp?: any): boolean {
  if (!baseMcp?.enabled || !baseMcp?.configured) return false;
  if (baseMcp.auth?.expired) return true;
  if (baseMcp.auth?.connected && baseMcp.usable === false) return true;
  if (baseMcp.auth?.connected) return false;
  return baseMcp.status === 'needs_reauth' || baseMcp.status === 'needs_auth' || baseMcp.status === 'missing' || baseMcp.status === 'degraded';
}

export function baseMcpConnectLabel(baseMcp?: any): string {
  return baseMcp?.auth?.connected ? 'Reconnect Base MCP' : 'Connect Base MCP';
}

export type BaseMcpIndicatorTone = 'connected' | 'action' | 'muted';

// T48a.1: compact status→label mapping for the sidebar Base MCP indicator.
// Reuses `baseMcpConnectLabel`/`baseMcpNeedsAuth` rather than re-deriving
// connect/reconnect wording, so the indicator and the existing Base MCP
// surfaces (BaseMcpView, AgentStream, OpsRail) never disagree about whether
// a reconnect is needed.
export function baseMcpStatusLabel(baseMcp?: any): {
  label: string;
  tone: BaseMcpIndicatorTone;
  action: 'connect' | 'reconnect' | null;
} {
  const healthyConnected = baseMcp?.auth?.connected === true && !baseMcpNeedsAuth(baseMcp);
  if (healthyConnected) {
    return { label: 'Base MCP: Connected', tone: 'connected', action: null };
  }
  return {
    label: baseMcpConnectLabel(baseMcp),
    tone: baseMcpNeedsAuth(baseMcp) ? 'action' : 'muted',
    action: baseMcp?.auth?.connected ? 'reconnect' : 'connect',
  };
}

export function baseMcpConnectHref(returnTo = '/base-mcp'): string {
  const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.includes('://')
    ? returnTo
    : '/base-mcp';
  return `/api/mcp/base/connect?returnTo=${encodeURIComponent(safeReturnTo)}&popup=1`;
}

export function baseMcpOAuthResultMessage(result?: string | null, code?: string | null, wallet?: string | null): { kind: 'success' | 'warn' | 'error'; text: string } | null {
  if (result === 'connected' && wallet === 'mismatch') {
    return {
      kind: 'warn',
      text: 'Base MCP is connected to another Coinbase wallet. Miorail will use your current BaseApp wallet for balances and confirmations. Coinbase wallet-specific MCP tools are disabled for this session.',
    };
  }
  if (result === 'connected') {
    return { kind: 'success', text: 'Base MCP connected. User-scoped tools are authorized.' };
  }
  if (result === 'cancelled') {
    return { kind: 'warn', text: 'Base MCP connection was cancelled. Connect again when ready.' };
  }
  if (result === 'error') {
    const messages: Record<string, string> = {
      expired_token: 'Base MCP authorization expired. Reconnect to continue.',
      refresh_failed: 'Base MCP token refresh failed. Reconnect to start a clean authorization flow.',
      credentials_invalid: 'Stored Base MCP credentials cannot be opened. Reconnect to replace them safely.',
      authorization_failed: 'Base MCP authorization failed or was cancelled. Reconnect when ready.',
      missing_config: 'Base MCP is not fully configured on the server.',
    };
    return { kind: 'error', text: messages[code || ''] || 'Base MCP connection failed. Connect again to reauthorize.' };
  }
  return null;
}

export function baseMcpCapabilityBreakdown(source?: any): {
  toolsCount: number;
  readOnly: number;
  userConfirmedTransaction: number;
  disabledOrUnknown: number;
  unknown: number;
} | null {
  if (!source) return null;
  const capabilities = source.capabilities;
  const readOnly = Number(capabilities?.readOnly ?? source.readOnlyToolsCount ?? 0);
  const userConfirmedTransaction = Number(
    capabilities?.userConfirmedTransaction ?? source.transactionToolsCount ?? 0,
  );
  const forbidden = Number(capabilities?.forbidden ?? source.forbiddenToolsCount ?? 0);
  const unknown = Number(capabilities?.unknown ?? source.unknownToolsCount ?? 0);
  const explicitToolsCount = Number(source.toolsCount ?? 0);
  const summedToolsCount = readOnly + userConfirmedTransaction + forbidden + unknown;
  const toolsCount = explicitToolsCount || summedToolsCount;
  if (!toolsCount && !summedToolsCount) return null;
  return {
    toolsCount,
    readOnly,
    userConfirmedTransaction,
    disabledOrUnknown: forbidden + unknown,
    unknown,
  };
}

export function approvalProviderState(status?: string): StateKind {
  if (status === 'connected') return 'live';
  if (status === 'partial' || status === 'rate_limited' || status === 'budget_exhausted' || status === 'temporarily_unavailable' || status === 'auth_or_budget_issue') return 'stale';
  if (status === 'failed') return 'failed';
  if (status === 'disabled') return 'disabled';
  return 'missing';
}

export function formatApprovalProviderStatus(approvals?: any, budgets?: any): string {
  const status = approvals?.status;
  const provider = approvals?.provider || 'none';
  const moralisBudget = budgets?.moralis;
  const effectiveStatus = provider === 'moralis' && moralisBudget?.budgetExhausted
    ? moralisBudget.status
    : status;
  if (effectiveStatus === 'connected') return `${provider} connected`;
  if (effectiveStatus === 'budget_exhausted' || effectiveStatus === 'auth_or_budget_issue') return `${provider} budget exhausted`;
  if (effectiveStatus === 'rate_limited') return `${provider} rate limited`;
  if (effectiveStatus === 'temporarily_unavailable' || effectiveStatus === 'partial') return `${provider} unavailable`;
  if (effectiveStatus === 'failed') return `${provider} failed`;
  if (effectiveStatus === 'disabled') return 'Disabled by config';
  return 'Missing';
}

export function approvalProviderHint(approvals?: any, budgets?: any): string | null {
  const provider = approvals?.provider;
  const status = provider === 'moralis' && budgets?.moralis?.budgetExhausted
    ? budgets.moralis.status
    : approvals?.status;
  if (status === 'budget_exhausted' || status === 'auth_or_budget_issue' || status === 'rate_limited' || status === 'temporarily_unavailable') {
    return 'Approval scanner unavailable — Moralis CU limit reached. Try after reset or upgrade provider.';
  }
  return null;
}

export function tokenSecurityIndicator(token: any, riskProviderStatus?: string) {
  const status = token.security?.status || (riskProviderStatus === 'missing' ? 'missing' : 'unknown');
  if (status === 'ok') return { className: 'bg-ok/70', title: 'Contract check: no major warnings detected' };
  if (status === 'warning') return { className: 'bg-warn', title: 'Contract check: warning flags detected' };
  if (status === 'high-risk') return { className: 'bg-risk', title: 'Contract check: high-risk flags detected' };
  if (status === 'failed') return { className: 'bg-ink-3', title: 'Contract check unavailable' };
  if (status === 'missing') return { className: 'bg-ink-3/50', title: 'Security provider missing' };
  return { className: 'bg-ink-3/50', title: 'Security not checked' };
}

export function securityBadgeClass(status?: string) {
  if (status === 'high-risk') return 'bg-risk-soft text-risk border-risk/20';
  if (status === 'warning') return 'bg-warn-soft text-warn border-warn/20';
  if (status === 'ok') return 'bg-ok-soft text-ok border-ok/20';
  return 'bg-panel text-ink-3 border-line';
}

export function securityFlagLabels(flags: any = {}) {
  const labels: string[] = [];
  if (flags.isHoneypot) labels.push('Honeypot');
  if (flags.isMintable) labels.push('Mintable');
  if (flags.isProxy) labels.push('Proxy');
  if (flags.hasBlacklist) labels.push('Blacklist');
  if (flags.hiddenOwner) labels.push('Hidden owner');
  const parseTax = (value?: string) => {
    if (!value) return 0;
    const n = Number(String(value).replace('%', '').trim());
    if (!Number.isFinite(n)) return 0;
    return n > 1 ? n / 100 : n;
  };
  if (parseTax(flags.buyTax) >= 0.1 || parseTax(flags.sellTax) >= 0.1) labels.push('High tax');
  return labels;
}

export function portfolioFreshnessChip(portfolio: any): { className: string; label: string } | null {
  const df = portfolio?.dataFreshness;
  if (!df) return null;
  const map: Record<string, { className: string; label: string }> = {
    live: { className: 'bg-ok-soft text-ok border-ok/20', label: 'Live' },
    cached: { className: 'bg-panel-2 text-ink-3 border-line/60', label: 'Cached' },
    stale: { className: 'bg-warn-soft text-warn border-warn/20', label: 'Stale' },
    partial: { className: 'bg-warn-soft text-warn border-warn/20', label: 'Partial' },
    failed: { className: 'bg-risk-soft text-risk border-risk/20', label: 'Provider failed' },
  };
  return map[df] || null;
}

export function portfolioFreshnessLabel(portfolio: any): string {
  const df = portfolio?.dataFreshness;
  const age = Number(portfolio?.cacheAgeSeconds ?? 0);
  if (df === 'live') return 'live just now';
  if (df === 'cached') return age > 0 ? `cached ${Math.max(1, Math.round(age / 60))} min ago` : 'cached just now';
  if (df === 'stale') return 'stale — showing cached data';
  if (df === 'partial') return 'partial — some providers unavailable';
  if (df === 'failed') return 'provider failed';
  return '';
}
