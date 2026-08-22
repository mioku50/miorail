import { portfolioFreshnessChip } from '../../lib/format';
import { capabilityLabel, capabilityState, capabilityTone, type CapabilityState } from '../../lib/capabilityStatus';

// The per-provider status chips + refresh control in the Portfolio card header.
// Extracted to keep PortfolioCard under the ~200-line view budget.
interface PortfolioProviderChipsProps {
  portfolio: any;
  statusData: any;
  address?: string;
  isPortfolioFetching: boolean;
  onRefresh: () => void;
}

export function PortfolioProviderChips({ portfolio, statusData, address, isPortfolioFetching, onRefresh }: PortfolioProviderChipsProps) {
  const freshness = portfolioFreshnessChip(portfolio);
  const balanceStatus = portfolio?.providerCallSummary?.balances?.status || portfolio?.providers?.tokenBalances || statusData?.tokenBalances?.status;
  const priceStatus = portfolio?.providers?.prices || statusData?.prices?.status;
  const riskStatus = portfolio?.providers?.risk || statusData?.risk?.status;
  const approvalScan = portfolio?.approvalScan || portfolio?.analysis?.providerContext;
  const approvalScanStatus = approvalScan?.status || approvalScan?.approvalScanStatus;

  const Chip = ({ label, state }: { label: string; state: CapabilityState }) => (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-sans font-semibold ${capabilityTone(state)}`}>
      {label} · {capabilityLabel(state)}
    </span>
  );

  return (
    <div className="flex items-center gap-1.5">
      {freshness && (
        <span className={`text-[10px] font-mono font-normal lowercase px-1.5 py-0.5 rounded border ${freshness.className}`} title={`Provider calls: ${portfolio?.providerCallsMade ?? 0}`}>
          portfolio {freshness.label.toLowerCase()}
        </span>
      )}
      <Chip label="Balances" state={capabilityState(balanceStatus)} />
      <Chip label="Prices" state={capabilityState(priceStatus)} />
      <Chip label="Contract checks" state={capabilityState(riskStatus)} />
      {portfolio && <Chip label="Approval review" state={capabilityState(approvalScanStatus)} />}
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
