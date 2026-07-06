import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { usePortfolio, useProtocols, useStatus, useToggleProtocol } from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';
import { isMainnetReadonly } from '../../lib/chain';
import { PortfolioCard } from './PortfolioCard';
import { ProtocolsCard } from './ProtocolsCard';
import { AutonomyCard } from '../autonomy/AutonomyCard';
import { FuelCard } from '../x402/FuelCard';

export function PortfolioRail() {
  const { address } = useAccount();
  // Portfolio is fetched only on explicit refresh/analyze — never automatically
  // on mount or on a timer — so free provider limits are not burned by page
  // loads. `portfolioRequested` flips the query enabled; subsequent refreshes
  // call refetch().
  const [portfolioRequested, setPortfolioRequested] = useState(false);

  useEffect(() => {
    setPortfolioRequested(false);
  }, [address]);
  const showToast = useUiStore((s) => s.showToast);
  const { data: portfolio, isError: isPortfolioError, error: portfolioError, refetch: refetchPortfolio, isFetching: isPortfolioFetching } = usePortfolio(address, { enabled: !!address && portfolioRequested, refetchInterval: false });
  const { data: protocolsData, isError: isProtocolsError } = useProtocols();
  const { data: statusData } = useStatus();
  const toggleProtocol = useToggleProtocol();

  const handleRefreshPortfolio = () => {
    if (!address) return;
    if (!portfolioRequested) setPortfolioRequested(true);
    else refetchPortfolio();
    showToast('Refreshing portfolio');
  };

  return (
    <aside className="w-[320px] min-w-[280px] shrink-0 border-r border-line bg-panel-2 p-4 flex flex-col gap-[14px] overflow-y-auto">
      <PortfolioCard
        portfolio={portfolio}
        statusData={statusData}
        address={address}
        isPortfolioFetching={isPortfolioFetching}
        isPortfolioError={isPortfolioError}
        portfolioError={portfolioError}
        handleRefreshPortfolio={handleRefreshPortfolio}
      />
      {!isMainnetReadonly && <AutonomyCard />}
      {!isMainnetReadonly && <FuelCard />}
      <ProtocolsCard
        statusData={statusData}
        protocolsData={protocolsData}
        isProtocolsError={isProtocolsError}
        address={address}
        toggleProtocol={toggleProtocol.mutate}
      />
    </aside>
  );
}
