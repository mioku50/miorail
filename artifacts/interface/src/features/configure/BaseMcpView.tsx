import { useStatus } from '@mioagent/api-client-react';
import { StateBadge } from '@mioagent/ui';

export function BaseMcpView() {
  const { data: sd } = useStatus();
  const mcpConfigured = sd ? sd.baseMcp.status === 'configured' : !!import.meta.env.VITE_MCP_SERVER_URL;
  const ap = sd?.approvals;

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto pb-16 md:pb-5">
      <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">Base MCP Status</h1>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">Server URL</span>
          <StateBadge state={mcpConfigured ? 'live' : 'missing'} label={mcpConfigured ? 'Configured (Env)' : 'Missing'} />
        </div>
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
        <div className="mt-2 p-3 bg-risk-soft rounded border border-risk/20 text-xs text-risk font-medium">
          Note: Without Base MCP approval provider (e.g. Coinbase Smart Wallet or 5792 compatible), write actions will fail closed during execution.
        </div>
        <button disabled className="bg-accent text-white px-4 py-2 rounded-lg text-sm w-fit mt-2 opacity-50 cursor-not-allowed disabled:cursor-not-allowed">
          Run Smoke Check
        </button>
      </div>
    </main>
  );
}
