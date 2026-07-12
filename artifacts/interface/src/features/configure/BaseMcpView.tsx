import { useBaseMcpToolsProbe, useStatus } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';
import { useAccount } from 'wagmi';
import {
  approvalProviderHint,
  approvalProviderState,
  baseMcpCapabilityBreakdown,
  baseMcpConnectHref,
  baseMcpConnectLabel,
  baseMcpHint,
  baseMcpOAuthResultMessage,
  baseMcpState,
  formatApprovalProviderStatus,
  formatBaseMcpStatus,
} from '../../lib/format';
import { PlugZap } from 'lucide-react';

export function BaseMcpView() {
  const { isConnected } = useAccount();
  const { data: sd } = useStatus();
  const toolsProbe = useBaseMcpToolsProbe();
  const mcp = sd?.baseMcp;
  const ap = sd?.approvals;
  const canConnect = !!mcp?.enabled && !!mcp?.configured;
  const capabilityBreakdown = baseMcpCapabilityBreakdown(toolsProbe.data || mcp);
  const connectLabel = baseMcpConnectLabel(mcp);
  const oauthParams = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const oauthResult = oauthParams?.get('mcp') ?? null;
  const oauthMessage = baseMcpOAuthResultMessage(oauthResult, null, oauthParams?.get('mcpWallet'));
  const oauthClassName = oauthMessage?.kind === 'success'
    ? 'bg-ok-soft border-ok/20 text-ok'
    : oauthMessage?.kind === 'error'
      ? 'bg-risk-soft border-risk/20 text-risk'
      : 'bg-warn-soft border-warn/20 text-warn';

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto pb-16 md:pb-5">
      <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">Base MCP Status</h1>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
        {oauthMessage && (
          <div className={`p-3 rounded border text-xs font-medium ${oauthClassName}`}>
            {oauthMessage.text}
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Provider</span>
          {mcp ? (
            <StateBadge state={baseMcpState(mcp.status)} label={formatBaseMcpStatus(mcp)} />
          ) : (
            <span className="text-xs text-ink-3 font-mono">Checking...</span>
          )}
        </div>
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Enabled</span>
          <StateBadge state={mcp?.enabled ? 'live' : mcp?.configured ? 'disabled' : 'missing'} label={mcp?.enabled ? 'enabled' : mcp?.configured ? 'disabled' : 'missing'} />
        </div>
        {mcp?.endpointHost && (
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Endpoint Host</span>
            <span className="text-xs text-ink-3 font-mono">{mcp.endpointHost}</span>
          </div>
        )}
        {mcp?.lastCheckedAt && (
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Last Checked</span>
            <span className="text-xs text-ink-3 font-mono">{new Date(mcp.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        )}
        {mcp?.capabilities && (
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Capabilities</span>
            <span className="text-xs text-ink-3 font-mono">
              tools {mcp.capabilities.toolsCount ?? 'unknown'} / resources {mcp.capabilities.resourcesCount ?? 'unknown'}
            </span>
          </div>
        )}
        {baseMcpHint(mcp) && (
          <div className="p-3 bg-panel-2 rounded border border-line text-xs text-ink-3 font-medium">
            {baseMcpHint(mcp)}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-sm">Base Account OAuth</span>
            <span className="text-xs text-ink-3">
              {mcp?.auth?.connected ? 'User-scoped MCP tokens are stored server-side.' : 'Optional: connect Base MCP to enable portfolio, send and swap via Base.'}
            </span>
            {mcp?.lastToolProbeAt && (
              <span className="text-[11px] text-ink-3 font-mono">
                Tools verified {new Date(mcp.lastToolProbeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {typeof mcp.toolsCount === 'number' ? ` / ${mcp.toolsCount} tools` : ''}
              </span>
            )}
          </div>
          {mcp?.auth?.connected ? (
            <button
              type="button"
              onClick={() => toolsProbe.mutate()}
              disabled={toolsProbe.isPending}
              className="inline-flex items-center gap-2 text-xs font-bold bg-panel-2 text-ink border border-line px-3.5 py-2 rounded-lg hover:bg-bg transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              <PlugZap size={14} />
              {toolsProbe.isPending ? 'Verifying...' : 'Verify tools'}
            </button>
          ) : canConnect && isConnected ? (
            <a
              href={baseMcpConnectHref('/base-mcp')}
              className="inline-flex items-center gap-2 text-xs font-bold bg-accent text-white px-3.5 py-2 rounded-lg hover:bg-accent/90 transition-colors shadow-sm"
            >
              <PlugZap size={14} />
              {connectLabel}
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 text-xs font-bold bg-panel-2 text-ink-3 border border-line px-3.5 py-2 rounded-lg opacity-70 cursor-not-allowed"
            >
              <PlugZap size={14} />
              {canConnect ? 'Connect wallet first' : 'Configure env first'}
            </button>
          )}
        </div>
        {toolsProbe.data?.status === 'connected' && (
          <div className="p-3 bg-ok-soft rounded border border-ok/20 text-xs text-ok font-medium">
            Base MCP connected. {toolsProbe.data.toolsCount} user-scoped tools available.
          </div>
        )}
        {capabilityBreakdown && mcp?.auth?.connected && (
          <div className="p-3 bg-panel-2 rounded border border-line text-xs text-ink-3 font-medium flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-ink font-bold">{capabilityBreakdown.toolsCount} tools available</span>
              <span>Read-only: {capabilityBreakdown.readOnly}</span>
              <span>User-confirmed tx: {capabilityBreakdown.userConfirmedTransaction}</span>
              <span>Disabled/unknown: {capabilityBreakdown.disabledOrUnknown}</span>
            </div>
            <span className="text-warn">Transaction tools are never auto-run. User confirmation is required.</span>
            {capabilityBreakdown.unknown > 0 && (
              <span className="text-warn">Unknown tools disabled by default.</span>
            )}
          </div>
        )}
        {toolsProbe.data?.status === 'needs_reauth' && (
          <div className="p-3 bg-warn-soft rounded border border-warn/20 text-xs text-warn font-medium">
            Base MCP token needs reauthorization. Reconnect Base MCP.
          </div>
        )}
        {(toolsProbe.data?.status === 'unreachable' || toolsProbe.data?.status === 'degraded') && (
          <div className="p-3 bg-warn-soft rounded border border-warn/20 text-xs text-warn font-medium">
            Base MCP tool probe is unavailable{toolsProbe.data.errorCode ? `: ${toolsProbe.data.errorCode}` : ''}. Existing portfolio and revoke flows are unaffected.
          </div>
        )}
        {toolsProbe.error && (
          <div className="p-3 bg-risk-soft rounded border border-risk/20 text-xs text-risk font-medium">
            Base MCP tool probe failed without changing any state.
          </div>
        )}
        {mcp?.status === 'unreachable' && (
          <div className="p-3 bg-risk-soft rounded border border-risk/20 text-xs text-risk font-medium">
            Base MCP status probe could not reach the configured host.
          </div>
        )}
        {mcp?.status === 'degraded' && (
          <div className="p-3 bg-warn-soft rounded border border-warn/20 text-xs text-warn font-medium">
            Base MCP status probe is degraded{mcp.errorCode ? `: ${mcp.errorCode}` : ''}.
          </div>
        )}
        {mcp?.status === 'unsupported' && (
          <div className="p-3 bg-warn-soft rounded border border-warn/20 text-xs text-warn font-medium">
            Base MCP responded, but this status path is not supported. OAuth connect remains available when the provider is enabled.
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Approval Provider</span>
          {sd ? (
            <StateBadge
              state={approvalProviderState(ap?.status)}
              label={formatApprovalProviderStatus(ap, sd.budgets)}
            />
          ) : (
            <span className="text-xs text-ink-3 font-mono">Checking...</span>
          )}
        </div>
        {approvalProviderHint(ap, sd?.budgets) && (
          <div className="p-3 bg-warn-soft rounded border border-warn/20 text-xs text-warn font-medium">
            {approvalProviderHint(ap, sd?.budgets)}
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Supported Chains</span>
          <span className="text-xs text-ink-3 font-mono">8453, 84532</span>
        </div>
        <div className="mt-2 p-3 bg-panel-2 rounded border border-line text-xs text-ink-3 font-medium">
          Base MCP is optional for MioRail status visibility. Read-only portfolio scans and user-confirmed Base Account actions do not require it.
        </div>
      </div>
    </main>
  );
}
