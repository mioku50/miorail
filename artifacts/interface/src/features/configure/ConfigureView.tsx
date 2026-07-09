import { useState, type ReactNode } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import {
  useStatus,
  useAutonomy,
  useTestnetConfigureAutonomy,
  useTestnetRevokeAutonomy,
  useTestnetExecuteAction,
  useResetAutonomy,
  useBaseMcpToolsProbe,
} from '@mioagent/api-client-react';
import { CHAIN_ENV } from '../../lib/chain';
import {
  approvalProviderHint,
  approvalProviderState,
  baseMcpCapabilityBreakdown,
  baseMcpConnectHref,
  baseMcpConnectLabel,
  baseMcpHint,
  baseMcpNeedsAuth,
  baseMcpOAuthResultMessage,
  baseMcpState,
  formatApprovalProviderStatus,
  formatBaseMcpStatus,
  formatRiskProvider,
} from '../../lib/format';
import { StateBadge, type StateKind } from '@mioagent/ui';
import { useUiStore } from '../../lib/state';
import { PlugZap } from 'lucide-react';

function tbState(s?: string): StateKind {
  if (s === 'connected') return 'live';
  if (s === 'stale') return 'stale';
  if (s === 'rate_limited') return 'stale';
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
  const toolsProbe = useBaseMcpToolsProbe();
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
      showToast('Test spend ran on testnet!');
      setActionStatus({ type: 'success', msg: `Test action ran successfully! Amount: ${res.amountUsdc} USDC to ${res.target}. Tx: ${res.txHash || 'Simulated/Verified'}` });
    },
    onError: (err: any) => {
      setActionStatus({ type: 'error', msg: err?.message || 'Test action failed (check nonce or spend limits)' });
    },
  });

  const resetMut = useResetAutonomy({
    onSuccess: () => {
      showToast('Memory state reset to unconfigured');
      setActionStatus({ type: 'success', msg: 'Memory autonomy config reset.' });
    },
  });

  const runtimeChainEnv = sd?.chainEnv || CHAIN_ENV;
  const runtimeIsSepolia = runtimeChainEnv === 'sepolia';
  const runtimeIsMainnetReadonly = runtimeChainEnv === 'mainnet-readonly';
  const isBaseSepolia = chainId === 84532;
  const isStale = runtimeIsSepolia && (autonomyState?.isStaleTestMemory || autonomyState?.sessionKey?.isStaleTestMemory);
  const isExpired = runtimeIsSepolia && (autonomyState?.isExpiredMemory || autonomyState?.sessionKey?.isExpiredMemory || autonomyState?.status === 'expired' || autonomyState?.sessionKey?.status === 'expired');
  const mcpOauthResult = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('mcp');
  const mcpOauthMessage = baseMcpOAuthResultMessage(mcpOauthResult);
  const baseMcpBreakdown = baseMcpCapabilityBreakdown(toolsProbe.data || sd?.baseMcp);
  const mcpOauthClassName = mcpOauthMessage?.kind === 'success'
    ? 'bg-ok-soft border-ok/20 text-ok'
    : mcpOauthMessage?.kind === 'error'
      ? 'bg-risk-soft border-risk/20 text-risk'
      : 'bg-warn-soft border-warn/20 text-warn';

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
            Manage provider connections, DB-backed spend permissions, and autonomy kill-switch boundaries.
          </p>
        </div>
      </div>

      {/* Autonomy & Session Key Configuration (Base Sepolia Testnet) */}
      {runtimeIsSepolia ? (
      <section className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink">Autonomy & Session Key (Base Sepolia Testnet)</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Configure onchain-verified spend permissions and session executors. Never exposed on mainnet.
            </p>
          </div>
          <StateBadge
            state={isStale ? 'stale' : isExpired ? 'stale' : autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract' ? 'live' : autonomyState?.sessionKey?.status === 'configured' ? 'live' : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch ? 'failed' : 'missing'}
            label={isStale ? 'stale test memory' : isExpired ? 'expired memory config' : autonomyState?.autonomy?.source === 'base-sepolia-contract' || autonomyState?.sessionKey?.source === 'base-sepolia-contract' ? 'testnet verified' : autonomyState?.sessionKey?.status === 'revoked' || autonomyState?.sessionKey?.status === 'inactive' || autonomyState?.sessionKey?.killSwitch ? 'revoked' : autonomyState?.autonomy?.source === 'memory' || autonomyState?.sessionKey?.source === 'memory' ? 'configured in app' : 'missing'}
            title={isStale ? 'Stale test memory detected. Click Reset Memory State below.' : isExpired ? 'Memory autonomy config has expired. Click Reset Memory State below.' : autonomyState?.autonomy?.source === 'base-sepolia-contract' ? 'Verified on Base Sepolia contract' : autonomyState?.sessionKey?.status === 'configured' ? 'Session key configured in app memory' : 'No session key is active'}
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
            {executeMut.isPending ? 'Running…' : 'Run Test Action (testnet, $5 USDC)'}
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
            className={`text-xs font-medium border px-3 py-2 rounded-lg transition-colors ${isStale || isExpired ? 'bg-warn-soft text-warn border-warn/30 hover:bg-warn/10' : 'bg-panel-2 text-ink-3 border-line hover:text-ink'}`}
          >
            {resetMut.isPending ? 'Resetting...' : isStale ? 'Reset Stale Memory' : isExpired ? 'Reset Expired Memory' : 'Reset Memory State'}
          </button>
        </div>
      </section>
      ) : (
      <section className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink">Autonomy & Spend Permissions (DB-backed)</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Current mode is Base Mainnet Read-only. Server execution is disabled; spend permission state is persisted in the database.
            </p>
          </div>
          <StateBadge
            state={sd?.autonomy?.databaseConfigured ? 'live' : 'missing'}
            label={sd?.autonomy?.databaseConfigured ? 'database-backed' : 'database missing'}
            title="Source: /api/status autonomy"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div className="bg-panel-2 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">Runtime Chain</div>
            <div className="mt-1 font-mono font-bold text-ink">{runtimeChainEnv}</div>
          </div>
          <div className="bg-panel-2 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">Persistence</div>
            <div className="mt-1 font-mono font-bold text-ink">{sd?.autonomy?.spendPermissionsPersistence || 'database'}</div>
          </div>
          <div className="bg-panel-2 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">Server Broadcast</div>
            <div className="mt-1 font-mono font-bold text-warn">disabled</div>
          </div>
          <div className="bg-panel-2 border border-line rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-[0.06em] text-ink-3">User Confirmation</div>
            <div className="mt-1 font-mono font-bold text-ok">{sd?.execution?.userConfirmedEnabled ? 'enabled' : 'not reported'}</div>
          </div>
        </div>
        <div className="text-[11px] text-ink-3 bg-panel-2 border border-line rounded-lg px-3 py-2">
          Mainnet automation remains read-only unless explicit user-confirmed wallet flow is used. Testnet setup controls are hidden for this runtime.
        </div>
      </section>
      )}

      {/* System Provider Status */}
      <section className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-3">
        <h3 className="text-sm font-bold text-ink mb-1">System Provider Status</h3>
        <Row label="Execution Mode">
          <div className="flex items-center gap-2">
            <span className="text-xs bg-panel-2 px-2.5 py-1 rounded border border-line font-mono text-ink">{sd?.execution?.mode || runtimeChainEnv}</span>
            {runtimeIsMainnetReadonly && <span className="text-xs text-warn bg-warn-soft px-2 py-0.5 rounded border border-warn/20 font-medium">Mainnet execution is disabled in read-only mode</span>}
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
          {sd ? <StateBadge state={approvalProviderState(sd.approvals?.status)} label={formatApprovalProviderStatus(sd.approvals, sd.budgets)} /> : <Checking />}
        </Row>
        {approvalProviderHint(sd?.approvals, sd?.budgets) && (
          <div className="text-[11px] text-warn bg-warn-soft border border-warn/20 rounded-md px-3 py-2">
            {approvalProviderHint(sd?.approvals, sd?.budgets)}
          </div>
        )}
        <Row label="Base MCP">
          <div className="flex items-center gap-2">
            {sd ? <StateBadge state={baseMcpState(sd.baseMcp.status)} label={formatBaseMcpStatus(sd.baseMcp)} /> : <Checking />}
            {sd?.baseMcp?.auth?.connected && (
              <button
                type="button"
                onClick={() => toolsProbe.mutate()}
                disabled={toolsProbe.isPending}
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-accent border border-accent/20 bg-accent/5 px-2 py-1 rounded-md hover:bg-accent/10 disabled:opacity-60 disabled:cursor-wait"
              >
                <PlugZap size={12} />
                {toolsProbe.isPending ? 'Verifying...' : 'Probe tools'}
              </button>
            )}
          </div>
        </Row>
        {baseMcpHint(sd?.baseMcp) && (
          <div className="text-[11px] text-ink-3 bg-panel-2 border border-line rounded-md px-3 py-2">
            {baseMcpHint(sd?.baseMcp)}
          </div>
        )}
        {toolsProbe.data?.status !== 'connected' && sd?.baseMcp?.auth?.connected && typeof sd.baseMcp.toolsCount === 'number' && (
          <div className="text-[11px] text-ok bg-ok-soft border border-ok/20 rounded-md px-3 py-2">
            Base MCP connected. {sd.baseMcp.toolsCount} user-scoped tools available.
          </div>
        )}
        {toolsProbe.data?.status === 'connected' && (
          <div className="text-[11px] text-ok bg-ok-soft border border-ok/20 rounded-md px-3 py-2">
            Base MCP connected. {toolsProbe.data.toolsCount} user-scoped tools available.
          </div>
        )}
        {baseMcpBreakdown && sd?.baseMcp?.auth?.connected && (
          <div className="text-[11px] text-ink-3 bg-panel-2 border border-line rounded-md px-3 py-2 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-bold text-ink">{baseMcpBreakdown.toolsCount} tools available</span>
              <span>Read-only: {baseMcpBreakdown.readOnly}</span>
              <span>User-confirmed tx: {baseMcpBreakdown.userConfirmedTransaction}</span>
              <span>Disabled/unknown: {baseMcpBreakdown.disabledOrUnknown}</span>
            </div>
            <span className="text-warn">Transaction tools are never auto-run. User confirmation is required.</span>
            {baseMcpBreakdown.unknown > 0 && (
              <span className="text-warn">Unknown tools disabled by default.</span>
            )}
          </div>
        )}
        {toolsProbe.data?.status === 'needs_reauth' && (
          <div className="text-[11px] text-warn bg-warn-soft border border-warn/20 rounded-md px-3 py-2">
            Reconnect Base MCP to refresh user-scoped tool access.
          </div>
        )}
        {(toolsProbe.data?.status === 'unreachable' || toolsProbe.data?.status === 'degraded') && (
          <div className="text-[11px] text-warn bg-warn-soft border border-warn/20 rounded-md px-3 py-2">
            Base MCP tool probe unavailable{toolsProbe.data.errorCode ? `: ${toolsProbe.data.errorCode}` : ''}. Read-only portfolio scans and revoke flow are unaffected.
          </div>
        )}
        {mcpOauthMessage && (
          <div className={`text-[11px] border rounded-md px-3 py-2 font-medium ${mcpOauthClassName}`}>
            {mcpOauthMessage.text}
          </div>
        )}
        {baseMcpNeedsAuth(sd?.baseMcp) && (
          <div className="flex items-center justify-between gap-3 text-[11px] bg-panel-2 border border-line rounded-md px-3 py-2">
            <span className="text-ink-3">Authorize user-scoped Base MCP tools.</span>
            {address ? (
              <a
                href={baseMcpConnectHref('/configure')}
                className="inline-flex items-center gap-1.5 font-bold text-accent hover:text-accent/80 whitespace-nowrap"
              >
                <PlugZap size={13} />
                {baseMcpConnectLabel(sd?.baseMcp)}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1.5 font-bold text-ink-3 whitespace-nowrap">
                <PlugZap size={13} />
                Connect wallet first
              </span>
            )}
          </div>
        )}
        <Row label="x402 Micropayments">
          {sd ? (
            <StateBadge
              state={sd.x402.settleReady ? 'live' : sd.x402.status === 'missing' ? 'missing' : 'mock'}
              label={
                sd.x402.settleReady ? 'Settlement ready' :
                sd.x402.status === 'facilitator_auth_required' ? 'Auth required' :
                sd.x402.status === 'facilitator_auth_invalid' ? 'Auth invalid' :
                sd.x402.status === 'facilitator_rate_limited' ? 'Rate limited' :
                sd.x402.status === 'facilitator_unreachable' ? 'Unreachable' :
                sd.x402.status === 'unsupported_network_for_settlement' ? 'Network blocked' :
                sd.x402.status === 'degraded' ? 'Degraded' :
                sd.x402.status === 'missing' ? 'Not configured' :
                'Simulated'
              }
              title={sd.x402.settleBlockedReason ? `x402: ${sd.x402.settleBlockedReason}` : sd.x402.errorCode ? `x402: ${sd.x402.errorCode}` : 'Source: /api/status x402.status'}
            />
          ) : <Checking />}
        </Row>
        <Row label="LLM Provider" last>
          <span className="text-xs font-medium px-2.5 py-0.5 rounded border bg-panel-2 text-ink-3 border-line" title="LLM provider status is not reported by /api/status">Not reported</span>
        </Row>
      </section>
    </main>
  );
}
