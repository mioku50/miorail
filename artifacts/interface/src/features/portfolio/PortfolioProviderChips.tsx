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
  const freshness = portfolioFreshnessChip(portfolio);
  const balancesProvider = portfolio?.providers?.tokenBalancesProvider || statusData?.tokenBalances?.provider || 'none';
  const priceProvider = portfolio?.providers?.priceProvider || statusData?.prices?.provider || 'none';
  const approvalProvider = portfolio?.providers?.approvalProvider || statusData?.approvals?.provider || 'none';
  const approvalScan = portfolio?.approvalScan || portfolio?.analysis?.providerContext;
  const approvalScanStatus = approvalScan?.status || approvalScan?.approvalScanStatus;

  const approvalScanLabel = (() => {
    if (!portfolio) return null;
    if (!approvalScanStatus || approvalScanStatus === 'not_requested') return 'approval scan not run';
    if (approvalScanStatus === 'live') return 'approval scan live';
    if (approvalScanStatus === 'cached') return 'approval scan cached';
    if (approvalScanStatus === 'stale') return 'approval scan stale';
    if (approvalScanStatus === 'partial') return 'approval scan partial';
    if (approvalScanStatus === 'failed') return 'approval scan failed';
    return `approval scan ${approvalScanStatus}`;
  })();
  const approvalScanClass = approvalScanStatus === 'live'
    ? 'text-ok bg-ok-soft border-ok/20'
    : approvalScanStatus === 'failed'
      ? 'text-risk bg-risk-soft border-risk/20'
      : approvalScanStatus === 'cached' || approvalScanStatus === 'stale' || approvalScanStatus === 'partial'
        ? 'text-warn bg-warn-soft border-warn/20'
        : 'text-ink-3 bg-panel-2 border-line/60';

  return (
    <div className="flex items-center gap-1.5">
      {freshness && (
        <span className={`text-[10px] font-mono font-normal lowercase px-1.5 py-0.5 rounded border ${freshness.className}`} title={`Provider calls: ${portfolio?.providerCallsMade ?? 0}`}>
          portfolio {freshness.label.toLowerCase()}
        </span>
      )}
      <span className="text-[10px] font-mono font-normal text-ink-3 lowercase bg-panel-2 px-1.5 py-0.5 rounded border border-line/60">
        balances {balancesProvider}
      </span>
      <span className="text-[10px] font-mono font-normal text-ink-3 lowercase bg-panel-2 px-1.5 py-0.5 rounded border border-line/60">
        prices {priceProvider}
      </span>
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
      <span className="text-[10px] font-mono font-normal text-ink-3 lowercase bg-panel-2 px-1.5 py-0.5 rounded border border-line/60">
        approvals {approvalProvider}
      </span>
      {approvalScanLabel && (
        <span className={`text-[10px] font-mono font-normal lowercase px-1.5 py-0.5 rounded border ${approvalScanClass}`}>
          {approvalScanLabel}
        </span>
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
