import { useState } from 'react';
import { isMainnetReadonly, explorerBaseUrl } from '../../lib/chain';
import { portfolioFreshnessLabel, tokenSecurityIndicator } from '../../lib/format';
import { PortfolioProviderChips } from './PortfolioProviderChips';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PortfolioCardProps {
  portfolio: any;
  statusData: any;
  address?: string;
  isPortfolioFetching: boolean;
  isPortfolioError: boolean;
  portfolioError: any;
  handleRefreshPortfolio: () => void;
}

export function PortfolioCard({ portfolio, statusData, address, isPortfolioFetching, isPortfolioError, portfolioError, handleRefreshPortfolio }: PortfolioCardProps) {
  const [showLowConfidence, setShowLowConfidence] = useState(false);

  const tokens = portfolio?.tokens || [];
  const ethToken = tokens.find((b: any) => b.symbol === 'ETH');
  const ethBalance = ethToken?.balanceFormatted || '0.00';
  const usdcToken = tokens.find((b: any) => b.symbol === 'USDC');
  const usdcBalance = usdcToken?.balanceFormatted;
  const displayAddress = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';

  const nonEthTokens = tokens.filter((b: any) => b.symbol !== 'ETH');
  const sortedTokens = [...nonEthTokens].sort((a: any, b: any) => {
    const valA = parseFloat(a.usdValue || '0');
    const valB = parseFloat(b.usdValue || '0');
    if (valB !== valA) return valB - valA;
    return a.symbol.localeCompare(b.symbol);
  });
  const highConfidenceTokens = sortedTokens.filter((b: any) => !b.possibleSpam && (b.verified || parseFloat(b.usdValue || '0') > 0 || b.logoUrl || b.symbol === 'USDC'));
  const lowConfidenceTokens = sortedTokens.filter((b: any) => !highConfidenceTokens.includes(b));
  const displayedTokens = showLowConfidence ? sortedTokens : highConfidenceTokens;

  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-[11px] flex items-center justify-between">
        Portfolio
        <PortfolioProviderChips
          portfolio={portfolio}
          statusData={statusData}
          address={address}
          isPortfolioFetching={isPortfolioFetching}
          onRefresh={handleRefreshPortfolio}
        />
      </div>

      {portfolio && (portfolio.dataFreshness || portfolio.providerBudgetStatus?.exhausted) && (
        <div className="flex items-center gap-1.5 -mt-1 mb-2 flex-wrap">
          {portfolio.dataFreshness && (
            <span className="text-[10px] font-mono font-normal text-ink-3 lowercase">
              {portfolioFreshnessLabel(portfolio)}
            </span>
          )}
          {portfolio.providerBudgetStatus?.exhausted && (
            <span className="text-[10px] font-mono font-normal text-warn lowercase bg-warn-soft px-1.5 py-0.5 rounded border border-warn/20">
              Provider budget reached — showing cached/stale data.
            </span>
          )}
        </div>
      )}


      {isPortfolioError ? (
         <div className="text-[13px] text-risk bg-risk-soft p-3 rounded-md font-medium border border-risk/20">
           {portfolioError?.message?.includes('wallet') || portfolioError?.message?.includes('address') ? 'Wallet address not configured' :
            portfolioError?.message?.includes('RPC') ? 'RPC provider not configured' :
            portfolioError?.message?.includes('key') ? 'Provider key missing' :
            'Unable to load portfolio'}
         </div>
      ) : !address ? (
         <div className="text-[13px] text-ink-2 bg-panel-2 p-3 rounded-md border border-line">
           Connect wallet to view portfolio
         </div>
      ) : !portfolio ? (
         <div className="text-[13px] text-ink-2 bg-panel-2 p-3 rounded-md border border-line flex flex-col gap-2">
           <span>Wallet connected. Refresh to load your portfolio.</span>
           <button
             type="button"
             onClick={handleRefreshPortfolio}
             disabled={isPortfolioFetching}
             className="self-start text-[11px] font-mono px-2 py-1 rounded border border-line/60 bg-bg text-ink-2 hover:text-ink hover:border-line disabled:opacity-40 disabled:cursor-not-allowed"
           >
             {isPortfolioFetching ? 'loading…' : 'Analyze Base Portfolio'}
           </button>
         </div>
      ) : (

        <>
          <div className="flex items-baseline mb-4 flex-col">
            {portfolio?.totalUsdValue ? (
              <div className="text-[28px] font-bold tracking-tight font-mono text-ink mb-1">
                ${portfolio.totalUsdValue} <span className="text-[14px] font-normal text-ink-3">total USD</span>
              </div>
            ) : null}
            <div className={`${portfolio?.totalUsdValue ? 'text-[20px]' : 'text-[30px]'} font-bold tracking-tight font-mono text-ink`}>
              {ethBalance} <span className={`${portfolio?.totalUsdValue ? 'text-[14px]' : 'text-[16px]'} text-ink-2`}>ETH</span>
            </div>
            {usdcBalance && !isMainnetReadonly && (
               <div className="text-[18px] font-bold tracking-tight font-mono text-ink mt-1">{usdcBalance} <span className="text-[14px] text-ink-2">testnet-USDC</span></div>
            )}
          </div>

          <div className="font-mono text-[12px] text-ink-3 mt-2 flex items-center gap-1.5">
            ⬡ {displayAddress} <a href={`${explorerBaseUrl}/address/${address}`} target="_blank" rel="noopener noreferrer" className="text-accent cursor-pointer ml-auto hover:underline">basescan ↗</a>
          </div>

          <div className="mt-4 flex flex-col gap-2">
             {displayedTokens.map((token: any, idx: number) => (
                <div key={idx} className="flex justify-between items-center text-[13px] py-1 border-b border-line/40 last:border-0">
                  <div className="flex items-center gap-2 overflow-hidden">
                    {token.logoUrl ? (
                      <img src={token.logoUrl} alt={token.symbol} className="w-5 h-5 rounded-full object-cover shrink-0" />
                    ) : (
                      <span className="w-5 h-5 rounded bg-[#2775ca] text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                         {token.symbol[0]}
                      </span>
                    )}
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="font-medium text-ink truncate" title={token.name || token.symbol}>{token.symbol}</span>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${tokenSecurityIndicator(token, portfolio?.providers?.risk).className}`} title={tokenSecurityIndicator(token, portfolio?.providers?.risk).title}></span>
                      {token.possibleSpam && <span className="text-[9px] bg-risk-soft text-risk px-1 rounded uppercase font-bold">spam</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex flex-col items-end">
                      <span className="font-mono font-medium">{token.balanceFormatted}</span>
                      {token.usdValue && (
                        <span className="font-mono text-[11px] text-ink-3">${token.usdValue}</span>
                      )}
                    </div>
                    {token.address && token.address !== 'native' && (
                      <a href={`${explorerBaseUrl}/token/${token.address}?a=${address}`} target="_blank" rel="noopener noreferrer" className="text-accent text-[11px] hover:underline font-mono" title="View on BaseScan">↗</a>
                    )}
                  </div>
                </div>
             ))}
             {highConfidenceTokens.length === 0 && lowConfidenceTokens.length > 0 && !showLowConfidence && (
               <div className="text-xs text-ink-3 italic py-1">Only unverified or low-value tokens found.</div>
             )}
             {lowConfidenceTokens.length > 0 && (
               <button onClick={() => setShowLowConfidence(!showLowConfidence)} className="text-[11px] text-accent font-medium mt-1 text-left hover:underline">
                 {showLowConfidence ? 'Hide unverified/low-value tokens' : `Show ${lowConfidenceTokens.length} unverified/low-value tokens`}
               </button>
             )}
          </div>
        </>
      )}
    </div>
  );
}
