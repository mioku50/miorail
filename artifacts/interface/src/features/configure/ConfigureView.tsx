import { type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { useStatus } from '@mioagent/api-client-react';
import { CHAIN_ENV, isMainnetReadonly } from '../../lib/chain';
import { formatRiskProvider } from '../../lib/format';
import { StateBadge, type StateKind } from '../../ui';

function tbState(s?: string): StateKind {
  if (s === 'connected') return 'live';
  if (s === 'stale') return 'stale';
  if (s === 'failed') return 'failed';
  if (s === 'disabled') return 'disabled';
  return 'missing';
}

function Row({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${last ? '' : 'border-b border-line'}`}>
      <span className="font-medium text-sm text-ink">{label}</span>
      {children}
    </div>
  );
}

const Checking = () => <span className="text-xs text-ink-3 font-mono">Checking...</span>;

export function ConfigureView() {
  const { address } = useAccount();
  const { data: sd } = useStatus();

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Configure</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-3">
        <Row label="Execution Mode">
          <div className="flex items-center gap-2">
            <span className="text-xs bg-panel-2 px-2.5 py-1 rounded border border-line font-mono text-ink">{sd?.execution?.mode || CHAIN_ENV}</span>
            {isMainnetReadonly && <span className="text-xs text-warn bg-warn-soft px-2 py-0.5 rounded border border-warn/20 font-medium">Mainnet execution is disabled in read-only mode</span>}
          </div>
        </Row>
        <Row label="Connected Wallet">
          <span className="text-xs bg-panel-2 px-2.5 py-1 rounded border border-line font-mono text-ink">{address || 'None'}</span>
        </Row>
        <Row label="Base RPC Provider">
          {sd ? <StateBadge state={sd.rpc.status === 'connected' ? 'live' : sd.rpc.status === 'failed' ? 'failed' : 'missing'} label={sd.rpc.status === 'connected' ? `Connected (${sd.rpc.provider})` : sd.rpc.status === 'failed' ? 'Failed' : 'Missing'} /> : <Checking />}
        </Row>
        <Row label="Token Balances Provider">
          {sd ? <StateBadge state={tbState(sd.tokenBalances.status)} label={
            sd.tokenBalances.status === 'connected' ? `${sd.tokenBalances.provider} connected` :
            sd.tokenBalances.status === 'stale' ? `${sd.tokenBalances.provider || 'moralis'} cached` :
            sd.tokenBalances.status === 'failed' ? `${sd.tokenBalances.provider || 'moralis'} failed` :
            sd.tokenBalances.status === 'disabled' ? 'Disabled by config' : 'Missing'
          } /> : <Checking />}
        </Row>
        <Row label="Price Provider">
          {sd ? <StateBadge state={sd.prices.status === 'connected' ? 'live' : sd.prices.status === 'failed' ? 'failed' : sd.prices.status === 'disabled' ? 'disabled' : 'missing'} label={
            sd.prices.status === 'connected' ? `${sd.prices.provider} connected` :
            sd.prices.status === 'failed' ? 'Price provider failed' :
            sd.prices.status === 'disabled' ? 'Disabled by config' : 'Missing'
          } /> : <Checking />}
        </Row>
        <Row label="Risk / GoPlus Provider">
          {sd ? <StateBadge state={sd.risk.status === 'connected' ? 'live' : sd.risk.status === 'partial' ? 'stale' : sd.risk.status === 'failed' ? 'failed' : sd.risk.status === 'disabled' ? 'disabled' : 'missing'} label={formatRiskProvider(sd)} /> : <Checking />}
        </Row>
        <Row label="Approval Scanner">
          {sd ? <StateBadge state={sd.approvals?.status === 'connected' ? 'live' : sd.approvals?.status === 'failed' ? 'failed' : sd.approvals?.status === 'disabled' ? 'disabled' : 'missing'} label={
            sd.approvals?.status === 'connected' ? `${sd.approvals?.provider || 'moralis'} connected` :
            sd.approvals?.status === 'failed' ? 'Failed' :
            sd.approvals?.status === 'disabled' ? 'Disabled by config' : 'Missing'
          } /> : <Checking />}
        </Row>
        <Row label="Base MCP">
          {sd ? <StateBadge state={sd.baseMcp.status === 'configured' ? 'live' : 'missing'} label={sd.baseMcp.status === 'configured' ? 'Configured' : 'Missing'} /> : <Checking />}
        </Row>
        <Row label="x402 Micropayments">
          {sd ? <StateBadge state={sd.x402.status === 'configured' ? 'live' : sd.x402.status === 'missing' ? 'missing' : 'mock'} label={sd.x402.status === 'configured' ? 'Configured' : sd.x402.status === 'missing' ? 'Not configured' : 'Simulated'} /> : <Checking />}
        </Row>
        <Row label="LLM Provider" last>
          <span className="text-xs font-medium px-2.5 py-0.5 rounded border bg-panel-2 text-ink-3 border-line" title="LLM provider status is not reported by /api/status">Not reported</span>
        </Row>
      </div>
    </main>
  );
}
