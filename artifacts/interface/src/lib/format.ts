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
  if (status === 'degraded' || status === 'needs_reauth') return 'stale';
  if (status === 'disabled') return 'disabled';
  if (status === 'unreachable' || status === 'unsupported') return 'failed';
  return 'missing';
}

export function formatBaseMcpStatus(baseMcp?: any, pendingLabel = 'Checking...') {
  if (!baseMcp) return pendingLabel;
  if (baseMcp.status === 'connected') return baseMcp.endpointHost ? `connected (${baseMcp.endpointHost})` : 'connected';
  if (baseMcp.status === 'needs_reauth') return 'needs reauth';
  if (baseMcp.status === 'degraded') return baseMcp.errorCode === 'rate_limited' ? 'degraded (rate limited)' : 'degraded';
  if (baseMcp.status === 'unreachable') return 'unreachable';
  if (baseMcp.status === 'unsupported') return 'unsupported';
  if (baseMcp.status === 'disabled') return 'disabled';
  return 'missing';
}

export function baseMcpHint(baseMcp?: any): string | null {
  if (!baseMcp) return null;
  if (baseMcp.status === 'needs_reauth') return 'Base MCP needs a fresh Base Account authorization.';
  if (baseMcp.status !== 'missing') return null;
  if (baseMcp.configured && baseMcp.enabled) return 'Base MCP is optional. Connect Base Account to enable user-scoped tool status.';
  return 'Base MCP is optional. Configure BASE_MCP_SERVER_URL to enable tool status.';
}

export function tokenSecurityIndicator(token: any, riskProviderStatus?: string) {
  const status = token.security?.status || (riskProviderStatus === 'missing' ? 'missing' : 'unknown');
  if (status === 'ok') return { className: 'bg-ok/70', title: 'GoPlus: no major warnings detected' };
  if (status === 'warning') return { className: 'bg-warn', title: 'GoPlus: warning flags detected' };
  if (status === 'high-risk') return { className: 'bg-risk', title: 'GoPlus: high-risk flags detected' };
  if (status === 'failed') return { className: 'bg-ink-3', title: 'GoPlus: security scan failed' };
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
