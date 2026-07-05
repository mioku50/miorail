import { useState, type ReactNode } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import {
  useStatus,
  useAutonomy,
  useTestnetConfigureAutonomy,
  useTestnetRevokeAutonomy,
  useTestnetExecuteAction,
  useResetAutonomy,
} from '@mioagent/api-client-react';
import { CHAIN_ENV, isMainnetReadonly } from '../../lib/chain';
import { formatRiskProvider } from '../../lib/format';
import { StateBadge, type StateKind } from '@mioagent/ui';
import { useUiStore } from '../../lib/state';

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
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: sd } = useStatus();
  const { data: autonomyState } = useAutonomy();
  const showToast = useUiStore((s) => s.showToast);

  const [dailyLimit, setDailyLimit] = useState('100');
  const [maxPerAction, setMaxPerAction] = useState('20');
  const [ttlHours, setTtlHours] = useState('24');
  const [whitelistAddr, setWhitelistAddr] = useState('');
  const [actionStatus, setActionStatus] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const configMut = useTestnetConfigureAutonomy({
    onSuccess: (res: any) => {
      showToast('Testnet spend permission configured successfully!');
      setActionStatus({ type: 'success', msg: `Spend permission active! Tx: ${res.txHash || 'Verified onchain/memory'}` });
    },
    onError: (err: any) => {
      setActionStatus({ type: 'error', msg: err?.message || 'Failed to configure testnet autonomy' });
    },
  });

  const revokeMut = useTestnetRevokeAutonomy({
    onSuccess: (res: any) => {
      showToast('Testnet spend permission revoked!');
      setActionStatus({ type: 'success', msg: `Kill switch activated! Tx: ${res.txHash || 'Revoked'}` });
    },
    onError: (err: any) => {
      setActionStatus({ type: 'error', msg: err?.message || 'Failed to revoke permission' });
    },
  });

  const executeMut = useTestnetExecuteAction({
    onSuccess: (res: any) => {
      showToast('Test action spend executed!');
      setActionStatus({ type: 'success', msg: `Test action executed successfully! Amount: ${res.amountUsdc} USDC to ${res.target}. Tx: ${res.txHash || 'Simulated/Verified'}` });
    },
    onError: (err: any) => {
      setActionStatus({ type: 'error', msg: err?.message || 'Action execution failed (check nonce or spend limits)' });
    },
  });

  const resetMut = useResetAutonomy({
    onSuccess: () => {
      showToast('Memory state reset to unconfigured');
      setActionStatus({ type: 'success', msg: 'Memory autonomy config reset.' });
    },
  });

  const isBaseSepolia = chainId === 84532;

  const handleSetupPermission = () => {
    setActionStatus(null);
    configMut.mutate({
      owner: address || '0x1111111111111111111111111111111111111111',
      dailyLimitUsdc: dailyLimit,
      maxPerActionUsdc: maxPerAction,
      ttlSeconds: Number(ttlHours) * 3600,
      whitelist: [whitelistAddr],
    });
  };

  const handleExecuteTest = () => {
    setActionStatus(null);
    executeMut.mutate({
      owner: address || '0x1111111111111111111111111111111111111111',
      amountUsdc: '5',
      target: whitelistAddr,
    });
  };

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-5 overflow-y-auto select-none pb-16 md:pb-5">
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div>
          <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">System & Autonomy Configuration</h1>
          <p className="text-[12px] text-ink-3 mt-0.5">
            Manage provider connections, testnet spend permissions, and autonomy kill-switch boundaries.
          </p>
        </div>
      </div>

      {/* Autonomy & Session Key Configuration (Base Sepolia Testnet) */}
      <section className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink">Autonomy & Session Key (Base Sepolia Testnet)</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Configure onchain-verified spend permissions and session executors. Never exposed on mainnet.
            </p>
          </div>
          <StateBadge
            state={autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory ? 'stale' : autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract' ? 'live' : autonomyState?.sessionKey?.status === 'configured' ? 'live' : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch ? 'failed' : 'missing'}
            label={autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory ? 'stale test memory' : autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract' ? 'testnet verified' : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch ? 'revoked' : autonomyState?.autonomy?.source === 'memory' || autonomyState?.sessionKey?.source === 'memory' ? 'configured in app' : 'missing'}
            title={autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory ? 'Stale test memory detected. Click Reset Memory State below.' : autonomyState?.autonomy?.source === 'base-sepolia-contract' ? 'Verified on Base Sepolia contract' : autonomyState?.sessionKey?.status === 'configured' ? 'Session key configured in app memory' : 'No session key is active'}
          />
        </div>

        {/* Network check */}
        <div className="flex items-center justify-between bg-panel-2 p-3 rounded-lg border border-line">
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-2 font-medium">Target Chain:</span>
            <span className={`text-xs font-mono px-2 py-0.5 rounded border ${isBaseSepolia ? 'bg-ok-soft text-ok border-ok/30' : 'bg-panel text-ink-3 border-line'}`}>
              {isBaseSepolia ? 'Base Sepolia (84532)' : `Chain ID: ${chainId || 'Unknown'}`}
            </span>
          </div>
          {!isBaseSepolia && switchChain && (
            <button
              onClick={() => switchChain({ chainId: 84532 })}
              className="text-xs font-bold bg-accent text-white px-3 py-1 rounded hover:bg-accent/90 transition-colors shadow-sm"
            >
              Switch to Base Sepolia (84532)
            </button>
          )}
        </div>

        {/* Configuration fields */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-ink-2">Daily Spend Limit (USDC)</label>
            <input
              type="number"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              className="bg-panel-2 border border-line rounded px-2.5 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-accent"
              placeholder="100"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-ink-2">Max / Action (USDC)</label>
            <input
              type="number"
              value={maxPerAction}
              onChange={(e) => setMaxPerAction(e.target.value)}
              className="bg-panel-2 border border-line rounded px-2.5 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-accent"
              placeholder="20"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-ink-2">Valid Duration (Hours)</label>
            <input
              type="number"
              value={ttlHours}
              onChange={(e) => setTtlHours(e.target.value)}
              className="bg-panel-2 border border-line rounded px-2.5 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-accent"
              placeholder="24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-ink-2">Whitelisted Target Address</label>
            <input
              type="text"
              value={whitelistAddr}
              onChange={(e) => setWhitelistAddr(e.target.value)}
              className="bg-panel-2 border border-line rounded px-2.5 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-accent"
              placeholder="0x..."
            />
          </div>
        </div>

        {/* Status message */}
        {actionStatus && (
          <div className={`text-xs p-3 rounded-lg border font-mono break-all ${actionStatus.type === 'success' ? 'bg-ok-soft text-ok border-ok/30' : 'bg-risk-soft text-risk border-risk/30'}`}>
            {actionStatus.msg}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <button
            onClick={handleSetupPermission}
            disabled={configMut.isPending}
            className="text-xs font-bold bg-accent text-white px-3.5 py-2 rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors shadow-sm"
          >
            {configMut.isPending ? 'Configuring...' : 'Setup Testnet Spend Permission'}
          </button>
          <button
            onClick={handleExecuteTest}
            disabled={executeMut.isPending}
            className="text-xs font-bold bg-panel-2 text-ink border border-line px-3.5 py-2 rounded-lg hover:bg-line/50 disabled:opacity-50 transition-colors"
          >
            {executeMut.isPending ? 'Executing...' : 'Execute Test Action ($5 USDC)'}
          </button>
          <button
            onClick={() => {
              setActionStatus(null);
              revokeMut.mutate({});
            }}
            disabled={revokeMut.isPending}
            className="text-xs font-bold bg-risk-soft text-risk border border-risk/30 px-3.5 py-2 rounded-lg hover:bg-risk/10 disabled:opacity-50 transition-colors ml-auto"
          >
            {revokeMut.isPending ? 'Revoking...' : 'Revoke Permission (Kill Switch)'}
          </button>
          <button
            onClick={() => {
              setActionStatus(null);
              resetMut.mutate();
            }}
            disabled={resetMut.isPending}
            className="text-xs font-medium bg-panel-2 text-ink-3 border border-line px-3 py-2 rounded-lg hover:text-ink transition-colors"
          >
            Reset Memory State
          </button>
        </div>
      </section>

      {/* System Provider Status */}
      <section className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-3">
        <h3 className="text-sm font-bold text-ink mb-1">System Provider Status</h3>
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
      </section>
    </main>
  );
}
