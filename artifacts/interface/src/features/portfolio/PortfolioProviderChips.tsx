import { portfolioFreshnessChip } from '../../lib/format';

// The per-provider status chips + refresh control in the Portfolio card header.
// Extracted to keep PortfolioCard under the ~200-line view budget.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PortfolioProviderChipsProps {
  portfolio: any;
  statusData: any;
  address?: string;
  isPortfolioFetching: boolean;
  onRefresh: () => void;
}

export function PortfolioProviderChips({ portfolio, statusData, address, isPortfolioFetching, onRefresh }: PortfolioProviderChipsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {portfolioFreshnessChip(portfolio) && (
        <span className={`text-[10px] font-mono font-normal lowercase px-1.5 py-0.5 rounded border ${portfolioFreshnessChip(portfolio)!.className}`} title={`Provider calls: ${portfolio?.providerCallsMade ?? 0}`}>
          {portfolioFreshnessChip(portfolio)!.label}
        </span>
      )}
      {(statusData || portfolio?.providerStatus) && (
        <span className="text-[10px] font-mono font-normal text-ink-3 lowercase bg-panel-2 px-1.5 py-0.5 rounded border border-line/60">
          {statusData ? (
            statusData.tokenBalances.status === 'stale' ? `${statusData.tokenBalances.provider || 'moralis'} cached` :
            statusData.tokenBalances.status === 'failed' ? 'token provider failed' :
            statusData.tokenBalances.status === 'disabled' ? 'balances off' :
            statusData.tokenBalances.status === 'missing' ? 'eth only' :
            statusData.tokenBalances.provider === 'moralis' ? 'moralis connected' :
            statusData.tokenBalances.provider === 'alchemy' ? 'alchemy connected' :
            portfolio?.providerStatus || 'connected'
          ) : (
            portfolio?.providers?.tokenBalances === 'stale' ? `${portfolio?.providers?.tokenBalancesProvider || 'moralis'} cached` :
            portfolio?.providers?.tokenBalances === 'failed' ? 'token provider failed' :
            portfolio?.providers?.tokenBalances === 'disabled' ? 'balances off' :
            portfolio?.providerStatus === 'moralis connected' ? 'moralis connected' : portfolio?.providerStatus
          )}
        </span>
      )}
      {(statusData?.prices.status === 'stale' || portfolio?.providers?.prices === 'stale') ? (
        <span className="text-[10px] font-mono font-normal text-warn lowercase bg-warn-soft px-1.5 py-0.5 rounded border border-warn/20">prices cached</span>
      ) : (statusData?.prices.status === 'failed' || portfolio?.providers?.prices === 'failed') ? (
        <span className="text-[10px] font-mono font-normal text-risk lowercase bg-risk-soft px-1.5 py-0.5 rounded border border-risk/20">prices failed</span>
      ) : null}
      {(statusData?.risk.status === 'stale' || portfolio?.providers?.risk === 'stale' || statusData?.risk.status === 'partial' || portfolio?.providers?.risk === 'partial') ? (
        <span className="text-[10px] font-mono font-normal text-warn lowercase bg-warn-soft px-1.5 py-0.5 rounded border border-warn/20">goplus cached</span>
      ) : (statusData?.risk.status === 'failed' || portfolio?.providers?.risk === 'failed') ? (
        <span className="text-[10px] font-mono font-normal text-risk lowercase bg-risk-soft px-1.5 py-0.5 rounded border border-risk/20">goplus failed</span>
      ) : null}
      {(statusData?.approvals?.status === 'connected' || portfolio?.providers?.approvals === 'connected') ? (
        <span className="text-[10px] font-mono font-normal text-ok lowercase bg-ok-soft px-1.5 py-0.5 rounded border border-ok/20">approvals connected</span>
      ) : (statusData?.approvals?.status === 'stale' || portfolio?.providers?.approvals === 'stale' || statusData?.approvals?.status === 'partial' || portfolio?.providers?.approvals === 'partial') ? (
        <span className="text-[10px] font-mono font-normal text-warn lowercase bg-warn-soft px-1.5 py-0.5 rounded border border-warn/20">approvals cached</span>
      ) : (statusData?.approvals?.status === 'failed' || portfolio?.providers?.approvals === 'failed') ? (
        <span className="text-[10px] font-mono font-normal text-risk lowercase bg-risk-soft px-1.5 py-0.5 rounded border border-risk/20">approvals failed</span>
      ) : (statusData?.approvals?.status === 'disabled' || portfolio?.providers?.approvals === 'disabled') ? (
        <span className="text-[10px] font-mono font-normal text-ink-3 lowercase bg-panel-2 px-1.5 py-0.5 rounded border border-line/60">approvals off</span>
      ) : (
        <span className="text-[10px] font-mono font-normal text-warn lowercase bg-warn-soft px-1.5 py-0.5 rounded border border-warn/20">approvals missing</span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={isPortfolioFetching || !address}
        title="Refresh portfolio"
        className="text-[10px] font-mono font-normal lowercase px-1.5 py-0.5 rounded border border-line/60 bg-panel-2 text-ink-2 hover:text-ink hover:border-line disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isPortfolioFetching ? 'refreshing…' : 'refresh'}
      </button>
    </div>
  );
}
