import { useAccount } from 'wagmi';
import { useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV, isMainnetReadonly } from '../../lib/chain';
import { formatRiskProvider } from '../../lib/format';

export function ConfigureView() {
  const { address } = useAccount();
  const { data: statusData } = useStatus();

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Configure</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Execution Mode</span>
          <div className="flex items-center gap-2">
            <span className="text-xs bg-panel-2 px-2.5 py-1 rounded border border-line font-mono text-ink">{statusData?.execution.mode || CHAIN_ENV}</span>
            {isMainnetReadonly && <span className="text-xs text-amber bg-amber-soft px-2 py-0.5 rounded border border-amber/20 font-medium">Mainnet execution is disabled in read-only mode</span>}
          </div>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Connected Wallet</span>
          <span className="text-xs bg-panel-2 px-2.5 py-1 rounded border border-line font-mono text-ink">{address || 'None'}</span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Base RPC Provider</span>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.rpc.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.rpc.status === 'failed' ? 'bg-red-soft text-red border-red/20' : 'bg-amber-soft text-amber border-amber/20'}`}>
            {statusData ? (statusData.rpc.status === 'connected' ? `Connected (${statusData.rpc.provider})` : statusData.rpc.status === 'failed' ? 'Failed' : 'Missing') : 'Checking...'}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Token Balances Provider</span>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.tokenBalances.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.tokenBalances.status === 'failed' ? 'bg-red-soft text-red border-red/20' : statusData?.tokenBalances.status === 'disabled' ? 'bg-panel-2 text-ink-3 border-line/60' : 'bg-amber-soft text-amber border-amber/20'}`}>
            {statusData ? (
              statusData.tokenBalances.status === 'connected' ? `${statusData.tokenBalances.provider} connected` :
              statusData.tokenBalances.status === 'stale' ? `${statusData.tokenBalances.provider || 'moralis'} cached` :
              statusData.tokenBalances.status === 'failed' ? `${statusData.tokenBalances.provider || 'moralis'} failed` :
              statusData.tokenBalances.status === 'disabled' ? 'Disabled by config' : 'Missing'
            ) : 'Checking...'}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Price Provider</span>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.prices.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.prices.status === 'failed' ? 'bg-red-soft text-red border-red/20' : statusData?.prices.status === 'disabled' ? 'bg-panel-2 text-ink-3 border-line/60' : 'bg-amber-soft text-amber border-amber/20'}`}>
            {statusData ? (statusData.prices.status === 'connected' ? `${statusData.prices.provider} connected` : statusData.prices.status === 'failed' ? 'Price provider failed' : statusData.prices.status === 'disabled' ? 'Disabled by config' : 'Missing') : 'Checking...'}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Risk / GoPlus Provider</span>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.risk.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.risk.status === 'failed' ? 'bg-red-soft text-red border-red/20' : statusData?.risk.status === 'disabled' ? 'bg-panel-2 text-ink-3 border-line/60' : 'bg-amber-soft text-amber border-amber/20'}`}>
            {formatRiskProvider(statusData)}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Approval Scanner</span>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.approvals?.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.approvals?.status === 'failed' ? 'bg-red-soft text-red border-red/20' : statusData?.approvals?.status === 'disabled' ? 'bg-panel-2 text-ink-3 border-line/60' : 'bg-amber-soft text-amber border-amber/20'}`}>
            {statusData ? (
              statusData.approvals?.status === 'connected' ? `${statusData.approvals?.provider || 'moralis'} connected` :
              statusData.approvals?.status === 'failed' ? 'Failed' :
              statusData.approvals?.status === 'disabled' ? 'Disabled by config' : 'Missing'
            ) : 'Checking...'}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">Base MCP</span>
          <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.baseMcp.status === 'configured' ? 'bg-green-soft text-green border-green/20' : 'bg-amber-soft text-amber border-amber/20'}`}>
            {statusData ? (statusData.baseMcp.status === 'configured' ? 'Configured' : 'Missing') : (import.meta.env.VITE_MCP_SERVER_URL ? 'Configured' : 'Missing')}
          </span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-line">
          <span className="font-medium text-sm text-ink">x402 Micropayments</span>
          <span className="text-xs font-medium px-2.5 py-0.5 rounded border bg-amber-soft text-amber border-amber/20">{statusData ? (statusData.x402.status === 'configured' ? 'Configured' : 'Simulated') : 'Simulated'}</span>
        </div>
        <div className="flex items-center justify-between py-1.5">
          <span className="font-medium text-sm text-ink">LLM Provider</span>
          <span className="text-xs font-medium px-2.5 py-0.5 rounded border bg-green-soft text-green border-green/20">Configured</span>
        </div>
      </div>
    </main>
  );
}
