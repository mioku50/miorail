import { useStatus } from '@mioagent/api-client-react';

export function BaseMcpView() {
  const { data: statusData } = useStatus();
  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Base MCP Status</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-sm">Server URL</span>
          <span className="text-xs text-ink-3 font-mono">{statusData ? (statusData.baseMcp.status === 'configured' ? 'Configured (Env)' : 'Missing') : (import.meta.env.VITE_MCP_SERVER_URL ? 'Configured (Env)' : 'Missing')}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-medium text-sm">Approval Provider</span>
          <span className="text-xs text-ink-3">Not configured in demo shell.</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-medium text-sm">Supported Chains</span>
          <span className="text-xs text-ink-3">8453, 84532</span>
        </div>
        <div className="mt-2 p-3 bg-red-soft rounded border border-red/20 text-xs text-red font-medium">
          Note: Without Base MCP approval provider (e.g. Coinbase Smart Wallet or 5792 compatible), write actions will fail closed during execution.
        </div>
        <button disabled className="bg-accent text-white px-4 py-2 rounded-lg text-sm w-fit mt-2 opacity-50 cursor-not-allowed disabled:cursor-not-allowed">
          Run Smoke Check
        </button>
      </div>
    </main>
  );
}
