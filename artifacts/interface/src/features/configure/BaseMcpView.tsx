import { useStatus } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';
import { baseMcpHint, baseMcpState, formatBaseMcpStatus } from '../../lib/format';

export function BaseMcpView() {
  const { data: sd } = useStatus();
  const mcp = sd?.baseMcp;
  const ap = sd?.approvals;

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto pb-16 md:pb-5">
      <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">Base MCP Status</h1>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
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
            Base MCP responded, but this status path is not supported.
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Approval Provider</span>
          {sd ? (
            <StateBadge
              state={ap?.status === 'connected' ? 'live' : ap?.status === 'failed' ? 'failed' : ap?.status === 'disabled' ? 'disabled' : 'missing'}
              label={
                ap?.status === 'connected' ? `${ap?.provider || 'moralis'} connected` :
                ap?.status === 'failed' ? 'Failed' :
                ap?.status === 'disabled' ? 'Disabled by config' : 'Missing'
              }
            />
          ) : (
            <span className="text-xs text-ink-3 font-mono">Checking...</span>
          )}
        </div>
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
