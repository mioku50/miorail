import { useState, useRef, useEffect } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { usePortfolio, useActionsFeed, useChatHistory, useSendMessage, useProtocols, useToggleProtocol, useExecuteAction, useDismissAction, useClearChatHistory, useClearActions, useCreateRecommendation, useStatus, useDismissAllRecommendations, useDeleteAllRecommendations, useDeleteAction, useRegenerateAction } from '@mioagent/api-client-react';


function WalletConnect({ showToast }: { showToast: (msg: string) => void }) {
  const { address, isConnected, isConnecting, chainId } = useAccount();
  const { connect, connectors, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  
  const expectedChainId = import.meta.env.VITE_CHAIN_ENV === 'sepolia' ? 84532 : 8453;
  const isWrongNetwork = isConnected && chainId !== expectedChainId;

  useEffect(() => {
    if (error) {
       showToast('Connection error: ' + error.message.split('\n')[0]);
    }
  }, [error]);

  if (isConnecting) {
    return (
      <button disabled className="bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] opacity-50 cursor-wait">
        Connecting...
      </button>
    );
  }

  if (isConnected) {
    if (isWrongNetwork) {
      return (
        <button 
          onClick={() => switchChain && switchChain({ chainId: expectedChainId })}
          className="bg-amber-soft text-amber border border-amber/20 px-[12px] py-[7px] rounded-[10px] text-[13px] hover:bg-amber-soft/80 transition-colors font-medium"
        >
          Switch to Base{expectedChainId === 84532 ? ' Sepolia' : ''}
        </button>
      );
    }

    return (
      <button 
        onClick={() => disconnect()}
        className="bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] hover:bg-line/50 transition-colors flex items-center gap-2"
        title="Disconnect Wallet"
      >
        <span className="w-2 h-2 rounded-full bg-green"></span>
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </button>
    );
  }

  return (
    <button 
      onClick={() => connect({ connector: connectors[0] })}
      className="bg-accent hover:bg-accent-2 text-white px-[12px] py-[7px] rounded-[10px] text-[13px] transition-colors font-medium shadow-sm"
    >
      Connect Wallet
    </button>
  );
}

function TopBar({ showToast, activeTab, setActiveTab, onOpenCommand }: { showToast: (msg: string) => void; activeTab: string; setActiveTab: (t: string) => void; onOpenCommand: () => void }) {
     const [tick, setTick] = useState(42);
     useEffect(() => {
       const timer = setInterval(() => setTick(t => t <= 0 ? 59 : t - 1), 1000);
       return () => clearInterval(timer);
     }, []);
  const tabs = ['main', 'actions builder', 'history', 'configure', 'base mcp'];

  return (
    <header className="h-[56px] flex items-center px-[18px] bg-panel border-b border-line gap-4">
      <div className="flex items-center gap-2 font-bold text-ink">
        <div className="w-[26px] h-[26px] rounded-lg bg-accent text-white flex items-center justify-center text-sm">◆</div>
        <span>Base Agent</span>
        {(!import.meta.env.VITE_CHAIN_ENV || import.meta.env.VITE_CHAIN_ENV === 'sepolia') ? (
          <span className="text-[10px] bg-accent-soft text-accent px-1.5 py-0.5 rounded ml-1">Base Sepolia</span>
        ) : import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly' ? (
          <span className="text-[10px] bg-amber-soft text-amber px-1.5 py-0.5 rounded ml-1 text-[#d97706] bg-[#fef3c7]">Base Mainnet · Read-only</span>
        ) : (import.meta.env.VITE_CHAIN_ENV === 'mainnet' && import.meta.env.VITE_MAINNET_EXECUTION_ENABLED === 'true') ? (
          <span className="text-[10px] bg-accent-soft text-accent px-1.5 py-0.5 rounded ml-1">Base Mainnet</span>
        ) : (
          <span className="text-[10px] bg-red-soft text-red px-1.5 py-0.5 rounded ml-1">Invalid Env</span>
        )}
      </div>

      <div className="flex gap-1 ml-4">
        {tabs.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-[13px] py-[7px] rounded-[10px] text-[13px] font-medium transition-colors ${
              activeTab === tab
                ? 'bg-accent-soft text-accent'
                : 'text-ink-2 hover:bg-bg'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1"></div>

      <div className="flex items-center gap-[9px] bg-green-soft text-green px-3 py-1.5 rounded-full text-xs font-medium">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green opacity-40"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green"></span>
        </span>
        4 scanners active · tick in <span className="font-mono ml-1">{`0:${String(tick).padStart(2, "0")}`}</span>
      </div>

      <button
        onClick={onOpenCommand}
        className="flex items-center gap-2 bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] hover:bg-line/50 transition-colors"
      >
        Command
        <kbd className="font-mono bg-white border border-line rounded-[6px] px-[6px] py-[1px] text-[11px] text-ink-2 shadow-sm">
          ⌘K
        </kbd>
      </button>

      <WalletConnect showToast={showToast} />
    </header>
  );
}

function formatRiskProvider(statusData: any, pendingLabel = 'Checking...') {
  if (!statusData) return pendingLabel;
  if (statusData.risk.status === 'connected') return statusData.risk.provider === 'goplus' ? 'GoPlus connected' : 'Connected';
  if (statusData.risk.status === 'partial') return statusData.risk.provider === 'goplus' ? 'GoPlus partial' : 'Partial';
  if (statusData.risk.status === 'failed') return statusData.risk.provider === 'goplus' ? 'GoPlus failed' : 'Failed';
  return 'Missing';
}

function tokenSecurityIndicator(token: any, riskProviderStatus?: string) {
  const status = token.security?.status || (riskProviderStatus === 'missing' ? 'missing' : 'unknown');
  if (status === 'ok') return { className: 'bg-green/70', title: 'GoPlus: no major warnings detected' };
  if (status === 'warning') return { className: 'bg-amber', title: 'GoPlus: warning flags detected' };
  if (status === 'high-risk') return { className: 'bg-red', title: 'GoPlus: high-risk flags detected' };
  if (status === 'failed') return { className: 'bg-ink-3', title: 'GoPlus: security scan failed' };
  if (status === 'missing') return { className: 'bg-ink-3/50', title: 'Security provider missing' };
  return { className: 'bg-ink-3/50', title: 'Security not checked' };
}

function securityBadgeClass(status?: string) {
  if (status === 'high-risk') return 'bg-red-soft text-red border-red/20';
  if (status === 'warning') return 'bg-amber-soft text-amber border-amber/20';
  if (status === 'ok') return 'bg-green-soft text-green border-green/20';
  return 'bg-panel text-ink-3 border-line';
}

function securityFlagLabels(flags: any = {}) {
  const labels: string[] = [];
  if (flags.isHoneypot) labels.push('Honeypot');
  if (flags.isMintable) labels.push('Mintable');
  if (flags.isProxy) labels.push('Proxy');
  if (flags.hasBlacklist) labels.push('Blacklist');
  if (flags.hiddenOwner) labels.push('Hidden owner');
  const parseTax = (value?: string) => {
    if (!value) return 0;
    const n = Number(String(value).replace('%', '').trim());
    if (!Number.isFinite(n)) return 0;
    return n > 1 ? n / 100 : n;
  };
  if (parseTax(flags.buyTax) >= 0.1 || parseTax(flags.sellTax) >= 0.1) labels.push('High tax');
  return labels;
}

function LeftRail({ showToast }: { showToast: (msg: string) => void }) {
  const { address } = useAccount();
  const { data: portfolio, isError: isPortfolioError, error: portfolioError } = usePortfolio(address);
  const { data: protocolsData, isError: isProtocolsError } = useProtocols();
  const { data: statusData } = useStatus();
  const { mutate: toggleProtocol } = useToggleProtocol();
  const [showLowConfidence, setShowLowConfidence] = useState(false);

  const tokens = portfolio?.tokens || [];
  const ethToken = tokens.find((b: any) => b.symbol === 'ETH');
  const ethBalance = ethToken?.balanceFormatted || '0.00';
  const usdcToken = tokens.find((b: any) => b.symbol === 'USDC');
  const usdcBalance = usdcToken?.balanceFormatted;
  const displayAddress = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';
  const explorerBaseUrl = isMainnetReadonly ? 'https://basescan.org' : 'https://sepolia.basescan.org';

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
    <aside className="w-[320px] min-w-[280px] shrink-0 border-r border-line bg-panel-2 p-4 flex flex-col gap-[14px] overflow-y-auto">
      {/* Portfolio Card */}
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-[11px] flex items-center justify-between">
          Portfolio
          <div className="flex items-center gap-1.5">
            {(statusData || portfolio?.providerStatus) && (
              <span className="text-[10px] font-mono font-normal text-ink-3 lowercase bg-panel-2 px-1.5 py-0.5 rounded border border-line/60">
                {statusData ? (
                  statusData.tokenBalances.status === 'stale' ? `${statusData.tokenBalances.provider || 'moralis'} cached` :
                  statusData.tokenBalances.status === 'failed' ? 'token provider failed' :
                  statusData.tokenBalances.status === 'missing' ? 'eth only' :
                  statusData.tokenBalances.provider === 'moralis' ? 'moralis connected' :
                  statusData.tokenBalances.provider === 'alchemy' ? 'alchemy connected' :
                  portfolio?.providerStatus || 'connected'
                ) : (
                  portfolio?.providers?.tokenBalances === 'stale' ? `${portfolio?.providers?.tokenBalancesProvider || 'moralis'} cached` :
                  portfolio?.providerStatus === 'moralis connected' ? 'moralis connected' : portfolio?.providerStatus
                )}
              </span>
            )}
            {(statusData?.prices.status === 'failed' || portfolio?.providers?.prices === 'failed') && (
              <span className="text-[10px] font-mono font-normal text-red lowercase bg-red-soft px-1.5 py-0.5 rounded border border-red/20">
                Prices failed
              </span>
            )}
            {(statusData?.risk.status === 'partial' || portfolio?.providers?.risk === 'partial') && (
              <span className="text-[10px] font-mono font-normal text-amber lowercase bg-amber-soft px-1.5 py-0.5 rounded border border-amber/20">
                GoPlus partial
              </span>
            )}
          </div>
        </div>

        
        {isPortfolioError ? (
           <div className="text-[13px] text-red bg-red-soft p-3 rounded-md font-medium border border-red/20">
             {portfolioError?.message?.includes('wallet') || portfolioError?.message?.includes('address') ? 'Wallet address not configured' :
              portfolioError?.message?.includes('RPC') ? 'RPC provider not configured' :
              portfolioError?.message?.includes('key') ? 'Provider key missing' :
              'Unable to load portfolio'}
           </div>
        ) : !portfolio || (!address) ? (
           <div className="text-[13px] text-ink-2 bg-panel-2 p-3 rounded-md border border-line">
             Connect wallet to view portfolio
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
                        {token.possibleSpam && <span className="text-[9px] bg-red-soft text-red px-1 rounded uppercase font-bold">spam</span>}
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

      {/* Autonomy Card */}
      {!isMainnetReadonly && (
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3">Autonomy <span className="lowercase font-normal tracking-normal text-ink-3/70 ml-1">(demo fixture)</span></div>
          <span className="text-[10px] font-bold text-accent bg-accent-soft px-[7px] py-[2px] rounded-[6px] tracking-[.05em]">SESSION KEY</span>
        </div>
        <div className="flex justify-between text-[12px] text-ink-2 mb-2"><span>Daily limit</span><span><b className="font-mono text-ink">$28</b> / $100</span></div>
        <div className="h-[7px] bg-line rounded-full overflow-hidden mb-1"><div className="h-full bg-accent" style={{width: "28%"}}></div></div>
        <div className="flex justify-between text-[12px] text-ink-2 mt-[8px] mb-[9px]"><span>Whitelist</span><b className="font-mono text-ink">USDC · BNKR · NOCK</b></div>
        <div className="flex justify-between text-[12px] text-ink-2 mb-[9px]"><span>Expires in</span><b className="font-mono text-ink">5:59:42</b></div>
        <button onClick={() => showToast("Autonomy stopped. Agent is waiting for manual confirmation.")} className="w-full py-[9px] rounded-[10px] bg-red-soft text-red font-bold text-[13px] flex items-center justify-center gap-[7px] hover:bg-red hover:text-white transition-colors">⏻ Kill switch</button>
      </div>
      )}

      {/* x402 Budget */}
      {!isMainnetReadonly && (
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">x402 budget <span className="lowercase font-normal tracking-normal text-ink-3/70 ml-1">(testnet-USDC)</span></div>
        <div className="flex items-baseline justify-between mb-2">
           <div className="font-mono text-[20px] font-bold text-ink">$1.84</div>
           <span className="text-[12px] font-bold bg-accent-soft text-accent px-[8px] py-[3px] rounded-[8px]">today</span>
        </div>
        <div className="h-[7px] bg-line rounded-full overflow-hidden mb-[6px]"><div className="h-full bg-accent" style={{width: "37%"}}></div></div>
        <div className="flex justify-between text-[12px] text-ink-2 mt-[6px] mb-[9px]"><span>inference · 142 calls</span><b className="font-mono text-ink">$1.12</b></div>
        <div className="flex justify-between text-[12px] text-ink-2"><span>tools · 38 calls</span><b className="font-mono text-ink">$0.72</b></div>
      </div>
      )}

      {/* Protocols */}
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">Protocols</div>
        {isMainnetReadonly ? (
           <div className="flex flex-col gap-2">
             <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
               <span className="text-ink-2">Base RPC</span>
               {statusData ? (
                 <span className={statusData.rpc.status === 'connected' ? 'text-green font-medium' : statusData.rpc.status === 'failed' ? 'text-red font-medium' : 'text-amber font-medium'}>
                   {statusData.rpc.status === 'connected' ? 'Connected' : statusData.rpc.status === 'failed' ? 'Failed' : 'Missing'}
                 </span>
               ) : address ? (
                 <span className="text-green font-medium">Connected</span>
               ) : (
                 <span className="text-amber font-medium">Missing</span>
               )}
             </div>
             <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
               <span className="text-ink-2">Token balances</span>
               {statusData ? (
                  <span className={statusData.tokenBalances.status === 'connected' ? 'text-green font-medium' : statusData.tokenBalances.status === 'failed' ? 'text-red font-medium' : 'text-amber font-medium'}>
                    {statusData.tokenBalances.status === 'connected' 
                      ? (statusData.tokenBalances.provider === 'moralis' ? 'Moralis connected' : statusData.tokenBalances.provider === 'alchemy' ? 'Alchemy connected' : 'Connected')
                      : statusData.tokenBalances.status === 'stale'
                        ? (statusData.tokenBalances.provider === 'moralis' ? 'Moralis cached' : 'Cached')
                        : statusData.tokenBalances.status === 'failed' ? (statusData.tokenBalances.provider === 'moralis' ? 'Moralis failed' : 'Failed') : 'Missing'}
                  </span>
                ) : (
                  <span className="text-amber font-medium">Missing</span>
                )}
             </div>
             <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
                <span className="text-ink-2">Risk provider</span>
                {statusData ? (
                  <span className={statusData.risk.status === 'connected' ? 'text-green font-medium' : statusData.risk.status === 'failed' ? 'text-red font-medium' : 'text-amber font-medium'}>
                    {formatRiskProvider(statusData, 'Missing')}
                  </span>
                ) : (
                  <span className="text-amber font-medium">Missing</span>
                )}
              </div>
              <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
                <span className="text-ink-2">Price Provider</span>
                {statusData ? (
                  <span className={statusData.prices.status === 'connected' ? 'text-green font-medium' : statusData.prices.status === 'failed' ? 'text-red font-medium' : 'text-amber font-medium'}>
                    {statusData.prices.status === 'connected' ? `Connected (${statusData.prices.provider})` : statusData.prices.status === 'failed' ? 'Price provider failed' : 'Missing'}
                  </span>
                ) : (
                  <span className="text-amber font-medium">Missing</span>
                )}
              </div>
             <div className="flex items-center justify-between py-1 text-[12px]">
               <span className="text-ink-2">Base MCP</span>
               {statusData ? (
                 <span className={statusData.baseMcp.status === 'configured' ? 'text-green font-medium' : 'text-amber font-medium'}>
                   {statusData.baseMcp.status === 'configured' ? 'Configured' : 'Missing'}
                 </span>
               ) : import.meta.env.VITE_MCP_SERVER_URL ? (
                 <span className="text-green font-medium">Configured</span>
               ) : (
                 <span className="text-red font-medium">Missing</span>
               )}
             </div>
           </div>
        ) : isProtocolsError || !protocolsData ? (
           <div className="text-[13px] text-red bg-red-soft p-3 rounded-md font-medium border border-red/20 mt-2">Provider disconnected</div>
        ) : (
          <div className="flex flex-col">
            {protocolsData.protocols.map((p: any, i: number) => (
               <div key={p.id} className={`flex items-center justify-between py-2 ${i !== protocolsData.protocols.length - 1 ? 'border-b border-line' : ''}`}>
                 <div className="flex items-center gap-2 text-[13px] text-ink font-medium">
                   <span className="w-[22px] h-[22px] bg-bg rounded-[7px] flex items-center justify-center text-[11px]">🔌</span>
                   {p.name}
                 </div>
                 <div
                   onClick={() => toggleProtocol({ protocolId: p.id, enabled: !p.enabled })}
                   className={`w-[36px] h-[20px] rounded-full p-[2px] cursor-pointer transition-colors ${p.enabled ? 'bg-accent' : 'bg-line'}`}
                 >
                   <div className={`w-[16px] h-[16px] bg-white rounded-full shadow-sm transform transition-transform ${p.enabled ? 'translate-x-[16px]' : ''}`}></div>
                 </div>
               </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function ActionInbox({ showToast, onSelectTab }: { showToast: (msg: string) => void; onSelectTab?: (tab: string) => void }) {
  const { address } = useAccount();
  const { data, isLoading, refetch } = useActionsFeed();
  const executeAction = useExecuteAction();
  const dismissAction = useDismissAction();
  const clearActions = useClearActions();
  const dismissAllRecs = useDismissAllRecommendations();
  const deleteAllRecs = useDeleteAllRecommendations();
  const deleteAction = useDeleteAction();
  const regenerateAction = useRegenerateAction();
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';

  const [filter, setFilter] = useState<string>('all');
  const [showManageMenu, setShowManageMenu] = useState<boolean>(false);

  const allActions = data?.actions || [];
  const actions = allActions.filter((a: any) => {
    if (filter === 'all') return a.status === 'pending';
    if (filter === 'signals') return a.status === 'pending' && (a.kind === 'signal' || a.kind === 'alert' || a.kind === 'transfer' || a.kind === 'swap');
    if (filter === 'recommendations') return a.status === 'pending' && a.kind === 'recommendation';
    if (filter === 'blocked') return a.status === 'pending' && (a.status === 'failed' || a.metadata?.safetyState === 'blocked' || a.metadata?.safetyState === 'failed');
    if (filter === 'history') return a.status === 'dismissed' || a.status === 'executed' || a.status === 'failed';
    return a.status === 'pending';
  });

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[16px] font-bold text-ink tracking-[-.02em]">Action Inbox</h2>
        <div className="flex gap-1.5 items-center flex-wrap">
          {['all', 'signals', 'recommendations', 'blocked', 'history'].map((f) => (
            <div key={f} onClick={() => setFilter(f)} className={`px-[11px] py-[5px] rounded-[9px] text-[12px] font-medium border cursor-pointer capitalize ${filter === f ? 'bg-accent text-white border-accent' : 'bg-panel text-ink-2 border-line hover:bg-bg'}`}>
              {f}
            </div>
          ))}

          <div className="relative ml-2">
            <button 
              onClick={() => setShowManageMenu(!showManageMenu)} 
              className="px-3 py-1.5 bg-panel border border-line rounded-[9px] text-xs font-semibold text-ink hover:bg-bg transition-colors flex items-center gap-1 shadow-sm"
            >
              Manage ▾
            </button>
            {showManageMenu && (
              <div className="absolute right-0 mt-1 w-64 bg-panel border border-line rounded-xl shadow-lg py-1 z-50 animate-in fade-in zoom-in-95">
                <button
                  onClick={() => {
                    setShowManageMenu(false);
                    dismissAllRecs.mutate(undefined, {
                      onSuccess: (res: any) => {
                        showToast(`Dismissed ${res?.count || 'all'} recommendations`);
                        refetch();
                      }
                    });
                  }}
                  disabled={dismissAllRecs.isPending}
                  className="w-full text-left px-3 py-2 text-xs text-ink hover:bg-bg transition-colors block font-medium"
                >
                  Dismiss all recommendations
                </button>
                <button
                  onClick={() => {
                    setShowManageMenu(false);
                    if (confirm('Permanently delete all recommendations? This cannot be undone.')) {
                      deleteAllRecs.mutate({ confirm: true }, {
                        onSuccess: (res: any) => {
                          showToast(`Deleted ${res?.count || 'all'} recommendations`);
                          refetch();
                        }
                      });
                    }
                  }}
                  disabled={deleteAllRecs.isPending}
                  className="w-full text-left px-3 py-2 text-xs text-red hover:bg-red-soft transition-colors block font-medium border-t border-line"
                >
                  Delete all recommendations
                </button>
                <button
                  onClick={() => {
                    setShowManageMenu(false);
                    if (confirm('This removes seeded demo actions only. Your recommendations will stay. Proceed?')) {
                      clearActions.mutate(undefined, {
                        onSuccess: (res: any) => {
                          if (res && res.count === 0) {
                            showToast('No demo actions to clear.');
                          } else {
                            showToast('Seeded demo actions cleared');
                          }
                          refetch();
                        }
                      });
                    }
                  }}
                  disabled={clearActions.isPending}
                  title="This removes seeded demo actions only. Your recommendations will stay."
                  className="w-full text-left px-3 py-2 text-xs text-ink-2 hover:bg-bg transition-colors block border-t border-line"
                >
                  Clear demo actions
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading && <div className="text-sm text-ink-3">Loading...</div>}
        {!isLoading && actions.length === 0 && (
          <div className="bg-panel border border-line rounded-xl p-8 text-center flex flex-col items-center gap-3 my-4">
            <div className="w-10 h-10 rounded-full bg-accent-soft text-accent flex items-center justify-center text-lg font-bold">⚡</div>
            <div className="text-base font-bold text-ink">No pending automated actions right now</div>
            <div className="text-xs text-ink-2 max-w-md leading-relaxed">
              Actions represent automated operations recommendations, token approvals, rebalances, or security screens.
            </div>
            <div className="text-xs text-ink-3 font-medium bg-bg px-3 py-1.5 rounded-lg border border-line mt-1">
              Create a new action recommendation below or interact with Agent Stream.
            </div>
            <div className="flex gap-2 mt-2">
              <button 
                onClick={() => onSelectTab && onSelectTab('actions builder')}
                className="px-3 py-1.5 bg-accent text-white text-xs rounded-lg font-medium hover:opacity-90 transition-opacity shadow-sm"
              >
                Create in Actions Builder
              </button>
              <button 
                onClick={() => {
                  const el = document.getElementById('agent-stream-input');
                  if (el) el.focus();
                }}
                className="px-3 py-1.5 bg-bg border border-line text-ink text-xs rounded-lg font-medium hover:bg-panel transition-colors"
              >
                Ask Agent Stream
              </button>
            </div>
          </div>
        )}
        {actions.map((action: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) => {
           const isPending = action.status === 'pending';
           const isExecuting = executeAction.isPending && executeAction.variables?.actionId === action.id;
           const isDismissing = dismissAction.isPending && dismissAction.variables?.actionId === action.id;
           const isDeleting = deleteAction.isPending && deleteAction.variables?.actionId === action.id;
           const isRegenerating = regenerateAction.isPending && regenerateAction.variables?.actionId === action.id;

           return (
             <div key={action.id} id={`action-${action.id}`} data-action-id={action.id} className={`bg-panel border rounded-xl shadow-sm p-[15px] flex flex-col gap-[10px] animate-in fade-in slide-in-from-bottom-2 ${action.status === 'failed' ? 'border-red-soft' : 'border-line'}`}>
                <div className="flex items-start justify-between gap-[10px]">
                   <div className="flex gap-[10px]">
                      <div className={`w-[9px] h-[9px] rounded-full shrink-0 mt-[5px] ${action.status === 'executed' ? 'bg-green' : action.status === 'pending' ? 'bg-amber' : 'bg-red'}`}></div>
                      <div>
                         <h3 className="text-[15px] font-bold text-ink tracking-[-.01em] uppercase">{action.kind}</h3>
                         <div className="font-mono text-[11px] text-ink-3 mt-1">
                           Created by: {action.metadata?.createdBy === 'agent-stream' ? 'Agent Stream' : action.metadata?.createdBy === 'actions-builder' ? 'Actions Builder' : action.metadata?.createdBy === 'scanner' || action.kind === 'alert' || action.kind === 'recommendation' ? 'Scanner' : 'System'}
                         </div>
                      </div>
                   </div>
                   <span className="text-[11px] text-ink-3 flex items-center gap-1">⟳ {new Date(action.createdAt).toLocaleTimeString()}</span>
                </div>

                <div className="text-[13px] text-ink-2 leading-relaxed">
                  {action.suggestedPrompt}
                </div>
                {(() => {
                   const meta = action.metadata || {};
                   const reason = meta.reason;
                   const expectedEffect = meta.expectedEffect;
                   const risk = meta.risk || 'medium';
                   const chainMode = meta.chainMode || (isMainnetReadonly ? 'mainnet-readonly' : 'sepolia');
                   const safetyState = meta.safetyState || (action.status === 'failed' ? 'blocked' : 'safe');
                   const riskColor = risk === 'low' ? 'bg-green-soft text-green border-green/20' : risk === 'high' ? 'bg-red-soft text-red border-red/20' : 'bg-amber-soft text-amber border-amber/20';
                   const safetyColor = safetyState === 'blocked' || safetyState === 'failed' ? 'bg-red-soft text-red border-red/20' : 'bg-green-soft text-green border-green/20';

                   return (
                     <div className="flex flex-col gap-2 bg-bg/50 border border-line rounded-lg p-3 text-xs mt-1">
                       {reason && (
                         <div>
                           <span className="font-semibold text-ink-2">Reason: </span>
                           <span className="text-ink-3">{reason}</span>
                         </div>
                       )}
                       {expectedEffect && (
                         <div>
                           <span className="font-semibold text-ink-2">Expected Effect: </span>
                           <span className="text-ink-3">{expectedEffect}</span>
                         </div>
                       )}
                       <div className="flex flex-wrap gap-1.5 mt-1">
                         <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${riskColor}`}>
                           Risk: {risk}
                         </span>
                         <span className="px-2 py-0.5 rounded text-[11px] font-medium border bg-panel text-ink-2 border-line">
                           Chain: {chainMode}
                         </span>
                         <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${safetyColor}`}>
                           Safety: {safetyState}
                         </span>
                       </div>
                       <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${(isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet') ? 'bg-amber-soft text-amber border-amber/20' : 'bg-green-soft text-green border-green/20'}`}>
                         {(isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet') 
                           ? 'Read-only recommendation (execution disabled on mainnet)' 
                           : 'Executable testnet recommendation'}
                       </div>
                       {meta.analysis && (
                         <div className="flex flex-col gap-3 bg-panel-2/50 border border-line rounded-lg p-3.5 text-xs mt-2">
                           <div className="font-semibold text-ink leading-snug border-b border-line pb-2">
                             📊 Portfolio Risk Analysis Summary
                           </div>
                           <div className="text-ink-2 leading-relaxed">
                             {meta.analysis.summary}
                           </div>
                           
                           {meta.analysis.portfolioSnapshot && (
                             <div className="flex flex-wrap gap-3 bg-bg p-2.5 rounded border border-line text-[11px]">
                               {meta.analysis.portfolioSnapshot.totalUsdValue && (
                                 <div>
                                   <span className="text-ink-3">Total Value: </span>
                                   <span className="font-semibold text-ink">${meta.analysis.portfolioSnapshot.totalUsdValue}</span>
                                 </div>
                               )}
                               <div>
                                 <span className="text-ink-3">Total Tokens: </span>
                                 <span className="font-semibold text-ink">{meta.analysis.portfolioSnapshot.tokenCount}</span>
                               </div>
                               <div>
                                 <span className="text-ink-3">Suspicious: </span>
                                 <span className={`font-semibold ${meta.analysis.portfolioSnapshot.suspiciousTokenCount > 0 ? 'text-red' : 'text-green'}`}>
                                   {meta.analysis.portfolioSnapshot.suspiciousTokenCount}
                                 </span>
                               </div>
                               <div>
                                 <span className="text-ink-3">Priced / Unpriced: </span>
                                 <span className="font-semibold text-ink">{meta.analysis.portfolioSnapshot.pricedTokenCount} / {meta.analysis.portfolioSnapshot.unpricedTokenCount}</span>
                               </div>
                               <div>
                                 <span className="text-ink-3">Security checked: </span>
                                 <span className="font-semibold text-ink">{meta.analysis.portfolioSnapshot.securityCheckedTokenCount || 0}</span>
                               </div>
                               <div>
                                 <span className="text-ink-3">High-risk security flags: </span>
                                 <span className={`font-semibold ${(meta.analysis.portfolioSnapshot.securityHighRiskCount || 0) > 0 ? 'text-red' : 'text-green'}`}>{meta.analysis.portfolioSnapshot.securityHighRiskCount || 0}</span>
                               </div>
                               <div>
                                 <span className="text-ink-3">Provider: </span>
                                 <span className="font-mono text-ink">{meta.analysis.portfolioSnapshot.provider}</span>
                               </div>
                               {meta.analysis.portfolioSnapshot.priceProvider && (
                                 <div>
                                   <span className="text-ink-3">Price provider: </span>
                                   <span className="font-mono text-ink">{meta.analysis.portfolioSnapshot.priceProvider}</span>
                                 </div>
                               )}
                               <div>
                                  <span className="text-ink-3">Security provider: </span>
                                  <span className="font-mono text-ink">{meta.analysis.securityProvider?.provider === 'goplus' ? (meta.analysis.securityProvider.status === 'failed' ? 'GoPlus failed' : meta.analysis.securityProvider.status === 'partial' ? 'GoPlus partial' : 'GoPlus') : 'Missing'}</span>
                                </div>
                             </div>
                           )}

                           {meta.analysis.tokenFindings && meta.analysis.tokenFindings.length > 0 && (
                             <div className="flex flex-col gap-1.5 mt-1">
                               <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
                                 Token Findings ({meta.analysis.tokenFindings.length})
                               </div>
                               <div className="flex flex-col gap-1.5 max-h-[240px] overflow-y-auto pr-1">
                                 {meta.analysis.tokenFindings.map((finding: any, idx: number) => {
                                   const fRiskColor = finding.risk === 'low' ? 'bg-green-soft text-green border-green/20' : finding.risk === 'high' ? 'bg-red-soft text-red border-red/20' : 'bg-amber-soft text-amber border-amber/20';
                                   const securityFlags = securityFlagLabels(finding.security?.flags);
                                   const basescanLink = finding.address && finding.address !== 'native' && !finding.address.includes('native')
                                     ? `https://${(isMainnetReadonly || chainMode === 'mainnet-readonly' || chainMode === 'mainnet') ? '' : 'sepolia.'}basescan.org/token/${finding.address}`
                                     : null;
                                   
                                   return (
                                     <div key={idx} className="flex flex-col gap-1 bg-bg/80 border border-line rounded p-2.5 text-[11px]">
                                       <div className="flex items-center justify-between gap-2">
                                         <div className="flex items-center gap-1.5 font-bold text-ink">
                                           <span>{finding.symbol}</span>
                                           {finding.balanceFormatted && (
                                              <span className="font-normal font-mono text-ink-3">
                                                ({finding.balanceFormatted}{finding.usdValue ? ` ~ $${finding.usdValue}` : ''})
                                              </span>
                                            )}
                                         </div>
                                         <div className="flex items-center gap-1.5">
                                           <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${fRiskColor}`}>
                                             {finding.risk}
                                           </span>
                                           {finding.security && (
                                             <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${securityBadgeClass(finding.security.status)}`}>
                                               Security: {finding.security.status}
                                             </span>
                                           )}
                                           {basescanLink && (
                                             <a href={basescanLink} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline text-[10px]" onClick={e => e.stopPropagation()}>
                                               BaseScan ↗
                                             </a>
                                           )}
                                         </div>
                                       </div>
                                       <div className="text-ink-2 text-[11px] leading-snug mt-0.5">
                                         {finding.reason}
                                       </div>
                                       {securityFlags.length > 0 && (
                                         <div className="flex flex-wrap gap-1 mt-1">
                                           {securityFlags.map((label: string) => (
                                             <span key={label} className="px-1.5 py-0.5 rounded bg-amber-soft text-amber border border-amber/20 text-[10px] font-semibold">
                                               {label}
                                             </span>
                                           ))}
                                         </div>
                                       )}
                                       <div className="text-[10px] text-ink-3 font-mono mt-0.5">
                                         Suggested handling: <span className="text-ink-2 font-semibold">{finding.suggestedHandling}</span>
                                       </div>
                                     </div>
                                   );
                                 })}
                               </div>
                             </div>
                           )}

                           {meta.analysis.suggestedNextSteps && meta.analysis.suggestedNextSteps.length > 0 && (
                             <div className="flex flex-col gap-1 mt-1 border-t border-line pt-2">
                               <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
                                 Suggested Next Steps
                               </div>
                               <ul className="list-disc list-inside space-y-1 text-ink-2 text-[11px]">
                                 {meta.analysis.suggestedNextSteps.map((step: string, sIdx: number) => (
                                   <li key={sIdx}>{step}</li>
                                 ))}
                               </ul>
                             </div>
                           )}
                         </div>
                       )}
                     </div>
                   );
                })()}
                {action.status === "failed" && (
                  <div className="flex items-center gap-[7px] text-[12px] font-bold text-red bg-red-soft px-[10px] py-[6px] rounded-[9px] mt-1 w-fit">
                     🛡️ blocked by security
                  </div>
                )}

                {action.tokens && action.tokens.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {action.tokens.map((t: string, i: number) => (
                       <span key={i} className="font-mono text-[11px] bg-bg px-[8px] py-[3px] rounded-[7px] text-ink-2">
                         {t}
                       </span>
                    ))}
                  </div>
                )}

                {action.status === 'failed' ? (
                   <div className="flex items-center gap-[7px] text-[12px] font-bold text-red bg-red-soft px-[10px] py-[6px] rounded-[9px] w-fit mt-1">
                      🛡️ failed
                   </div>
                ) : (
                  <div className="flex gap-2 items-center flex-wrap mt-1">
                     <span title={(isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') ? "Mainnet execution is disabled in read-only mode." : undefined} onClick={() => { if(isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') showToast("Mainnet execution is disabled in read-only mode."); }}>
                     <button
                       onClick={() => {
                         if (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') {
                           showToast("Mainnet execution is disabled in read-only mode.");
                           return;
                         }
                         executeAction.mutate({ actionId: action.id }, { 
    onSuccess: (data: any) => { 
      if (data?.success && data?.approvalUrl) { 
        window.open(data.approvalUrl, '_blank'); 
      } else if (data?.error) {
        if (data.error.includes('MCP') || data.error.includes('Approval provider') || data.error.includes('Backend failed')) {
          showToast('Approval provider is not configured. Action was not executed.');
        } else {
          if (data.error.includes('Mainnet execution is disabled')) {
            showToast(data.error);
          } else {
            showToast('Error: ' + data.error);
          }
        }
      } else {
        showToast('Approval provider is not configured. Action was not executed.');
      }
      refetch(); 
    },
    onError: (err: any) => {
      showToast('Error: ' + err.message);
      refetch();
    }
  });
                       }}
                       disabled={!isPending || isExecuting || isDismissing || isDeleting || isRegenerating || isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet'}
                       className="bg-accent hover:bg-accent-2 text-white px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] shadow-[0_6px_16px_rgba(0,0,255,.28)] hover:-translate-y-[1px] hover:shadow-[0_10px_22px_rgba(0,0,255,.34)] transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       ⚡ {isExecuting ? 'Executing...' : (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') ? 'Read-only' : 'Execute'}
                     </button>
                     </span>
                     {action.kind === 'recommendation' && (
                       <button
                         onClick={() => regenerateAction.mutate({ actionId: action.id, walletAddress: address, chainEnv: import.meta.env.VITE_CHAIN_ENV || 'mainnet-readonly' }, { onSuccess: () => { showToast('Recommendation analysis regenerated'); refetch(); } })}
                         disabled={isExecuting || isDismissing || isDeleting || isRegenerating}
                         className="bg-bg hover:bg-panel border border-line text-ink px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                       >
                         {isRegenerating ? 'Regenerating...' : 'Regenerate analysis'}
                       </button>
                     )}
                     <button
                       onClick={() => dismissAction.mutate({ actionId: action.id }, { onSuccess: () => refetch() })}
                       disabled={!isPending || isExecuting || isDismissing || isDeleting || isRegenerating}
                       className="bg-bg hover:bg-[#eceef7] text-ink-2 px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       {isDismissing ? 'Dismissing...' : 'Dismiss'}
                     </button>
                     <button
                       onClick={() => {
                         if (confirm('Permanently delete this action?')) {
                           deleteAction.mutate({ actionId: action.id }, { onSuccess: () => { showToast('Action deleted'); refetch(); } });
                         }
                       }}
                       disabled={isExecuting || isDismissing || isDeleting || isRegenerating}
                       className="bg-bg hover:bg-red-soft text-red px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       {isDeleting ? 'Deleting...' : 'Delete'}
                     </button>
                  </div>
                )}
             </div>
           );
        })}
      </div>
    </main>
  );
}

function AgentStream({ showToast, onSelectTab }: { showToast: (msg: string) => void; onSelectTab?: (tab: string) => void }) {
  const { address } = useAccount();
  const { data: chatData, refetch } = useChatHistory();
  const sendMessageMutation = useSendMessage();
  const clearChat = useClearChatHistory();
  const [input, setInput] = useState('');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messages = chatData?.messages || [];
  const displayMessages = messages;

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [displayMessages, isCollapsed]);

  const handleSendMsg = async (msgText: string) => {
    if (!msgText.trim() || sendMessageMutation.isPending) return;
    setErrorMsg(null);
    setInput('');
    try {
       await sendMessageMutation.mutateAsync({ 
         message: msgText,
         walletAddress: address,
         chainEnv: import.meta.env.VITE_CHAIN_ENV || 'sepolia'
       });
       refetch();
       setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (err: any) {
       console.error(err);
       const errMsg = err.message || "Failed to send instruction";
       setErrorMsg(errMsg);
       showToast('Error: ' + errMsg);
    }
  };

  const handleNewChat = () => {
    if (displayMessages.length > 0 && !confirm('Start a new chat? This clears the current visible thread.')) {
      return;
    }
    clearChat.mutate(undefined, {
      onSuccess: () => {
        refetch();
        showToast('New chat started');
        setErrorMsg(null);
      }
    });
  };

  const PROMPT_CHIPS = [
    "Review my Base tokens",
    "Check token security",
    "Create a read-only rebalance plan",
    "Check spend permissions",
    "Find yield opportunities"
  ];

  if (isCollapsed) {
    return (
      <aside className="w-[54px] shrink-0 border-l border-line bg-panel flex flex-col items-center py-4 justify-between select-none shadow-sm z-10">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2.5 rounded-xl hover:bg-bg text-ink-2 hover:text-ink transition-colors flex flex-col items-center gap-2 shadow-sm border border-transparent hover:border-line cursor-pointer"
          title="Expand Agent Stream"
          aria-label="Expand Agent Stream"
        >
          <span className="text-base">💬</span>
          <span className="text-[11px] font-bold tracking-wider uppercase text-ink-3 [writing-mode:vertical-rl] rotate-180 py-2">Agent</span>
        </button>
        <div className="w-2.5 h-2.5 rounded-full bg-green animate-pulse" title="Agent Ready" />
      </aside>
    );
  }

  return (
    <aside className="w-[400px] shrink-0 border-l border-line bg-panel flex flex-col h-full overflow-hidden shadow-sm z-10">
       {/* Header */}
       <div className="px-4 py-3 border-b border-line bg-panel flex items-center justify-between shrink-0">
         <div className="flex items-center gap-2.5">
           <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${sendMessageMutation.isPending ? 'bg-amber animate-ping' : sendMessageMutation.isError ? 'bg-red' : 'bg-green animate-pulse'}`} title="Status" />
           <div>
             <div className="text-sm font-bold text-ink flex items-center gap-2">
               <span>Agent Stream</span>
               <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${sendMessageMutation.isPending ? 'bg-amber-soft text-amber' : sendMessageMutation.isError ? 'bg-red-soft text-red' : 'bg-green-soft text-green'}`}>
                 {sendMessageMutation.isPending ? "Thinking..." : sendMessageMutation.isError ? "Error" : displayMessages.some((m: any) => m.role === 'assistant' && (m.actionId || m.metadata?.actionId)) ? "Recommendation created" : "Ready"}
               </span>
             </div>
             <div className="text-[11px] text-ink-3 font-medium">
               Base Mainnet · Read-only {address ? "· Connected" : ""}
             </div>
           </div>
         </div>
         <div className="flex items-center gap-1.5">
           <button
             onClick={handleNewChat}
             className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-panel-2 border border-line hover:bg-bg text-ink-2 hover:text-ink transition-colors flex items-center gap-1 shadow-sm cursor-pointer"
             aria-label="New chat"
           >
             <span>+ New chat</span>
           </button>
           <button
             onClick={() => setIsCollapsed(true)}
             className="p-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-bg transition-colors cursor-pointer text-xs font-bold"
             title="Collapse panel"
             aria-label="Collapse panel"
           >
             ⇥
           </button>
         </div>
       </div>

       {/* Stream */}
       <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-bg/40" ref={streamRef}>
          {displayMessages.length === 0 && (
             <div className="h-full flex flex-col items-center justify-center p-2 text-center my-auto animate-in fade-in">
               <div className="w-12 h-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center text-2xl mb-3 shadow-sm">
                 ✨
               </div>
               <h3 className="text-sm font-bold text-ink mb-1.5">
                 Ask MioAgent anything about your Base wallet
               </h3>
               <p className="text-xs text-ink-2 max-w-[280px] leading-relaxed mb-6">
                 MioAgent can review your portfolio, flag suspicious tokens, create read-only recommendations, and explain what it would do before any execution.
               </p>
               <div className="flex flex-wrap gap-2 justify-center max-w-[340px]">
                 {PROMPT_CHIPS.map((chip, idx) => (
                   <button
                     key={idx}
                     onClick={() => handleSendMsg(chip)}
                     disabled={sendMessageMutation.isPending}
                     className="px-3 py-1.5 rounded-xl text-xs font-medium bg-panel border border-line text-ink-2 hover:text-accent hover:border-accent/40 shadow-sm transition-all text-left cursor-pointer disabled:opacity-50"
                   >
                     {chip}
                   </button>
                 ))}
               </div>
             </div>
          )}

          {displayMessages.map((m: any, i: number) => {
            if (m.role === 'user') {
              return (
                <div key={i} className="flex flex-col items-end gap-1 animate-in fade-in slide-in-from-right-1">
                  <div className="bg-accent text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-[13px] font-medium leading-relaxed max-w-[88%] shadow-sm break-words">
                    {m.content}
                  </div>
                  <span className="text-[10px] text-ink-3 font-mono mr-1">User</span>
                </div>
              );
            }
            if (m.role === 'assistant') {
              const actionIdVal = m.actionId || m.metadata?.actionId;
              const meta = m.metadata || {};
              const riskVal = meta.risk || 'low';
              return (
                <div key={i} className="flex flex-col items-start gap-1 w-full animate-in fade-in slide-in-from-left-1">
                  {m.content && (
                    <div className="bg-panel border border-line rounded-2xl rounded-tl-sm px-4 py-3 text-[13px] text-ink font-normal leading-relaxed max-w-[92%] shadow-sm break-words mb-1.5">
                      {m.content}
                    </div>
                  )}
                  {actionIdVal && (
                    <div className="w-full bg-panel border-2 border-accent/20 rounded-2xl p-4 shadow-md bg-gradient-to-br from-panel to-panel-2">
                      <div className="flex items-center justify-between mb-3 pb-2 border-b border-line">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-ink">
                          <span className="text-accent">⚡</span> Read-only recommendation created
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-accent-soft text-accent">
                          New
                        </span>
                      </div>
                      
                      <div className="space-y-2 text-xs text-ink-2 mb-4">
                        <div className="flex items-center justify-between">
                          <span className="text-ink-3">Action ID</span>
                          <span className="font-mono font-medium text-ink bg-bg px-1.5 py-0.5 rounded text-[11px]">
                            {actionIdVal.slice(0, 10)}...
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-ink-3">Source</span>
                          <span className="font-medium text-ink">Agent Stream</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-ink-3">Mode</span>
                          <span className="font-medium text-ink">Base Mainnet · Read-only</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-ink-3">Safety</span>
                          <span className="font-medium text-red flex items-center gap-1 bg-red-soft px-2 py-0.5 rounded-full text-[11px]">
                            🛡️ Execution blocked
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-ink-3">Risk Level</span>
                          <span className={`font-semibold px-2 py-0.5 rounded-full text-[11px] uppercase tracking-wide ${
                            riskVal === 'high' ? 'bg-red-soft text-red' :
                            riskVal === 'medium' ? 'bg-amber-soft text-amber' :
                            'bg-green-soft text-green'
                          }`}>
                            {riskVal}
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          if (onSelectTab) onSelectTab('main');
                          showToast("Focused Action Inbox recommendation");
                          setTimeout(() => {
                            const el = document.getElementById(`action-${actionIdVal}`) || document.querySelector(`[data-action-id="${actionIdVal}"]`);
                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }, 150);
                        }}
                        className="w-full py-2 px-3 bg-accent hover:bg-accent-2 text-white font-semibold text-xs rounded-xl shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                        aria-label="View in Action Inbox"
                      >
                        <span>View in Action Inbox</span>
                        <span>→</span>
                      </button>
                    </div>
                  )}
                  {!actionIdVal && !m.content && m.toolCalls && m.toolCalls.length > 0 && (
                    <div className="w-full bg-panel border border-line rounded-xl p-3 space-y-2 text-xs font-mono shadow-sm">
                      {m.toolCalls.map((tc: any, idx: number) => (
                        <div key={idx} className="flex items-center gap-2 text-ink-2">
                          <span className="text-green font-bold">✓</span>
                          <span className="font-semibold text-ink">{tc.name}</span>
                          <span className="text-ink-3 truncate">{JSON.stringify(tc.arguments)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <span className="text-[10px] text-ink-3 font-mono ml-1">MioAgent</span>
                </div>
              );
            }
            return null;
          })}
       </div>

       {/* Prompt chips when thread has messages */}
       {displayMessages.length > 0 && (
         <div className="overflow-x-auto no-scrollbar flex gap-2 px-4 py-2 border-t border-line bg-panel-2/70 shrink-0">
           {PROMPT_CHIPS.map((chip, idx) => (
             <button
               key={idx}
               onClick={() => handleSendMsg(chip)}
               disabled={sendMessageMutation.isPending}
               className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-panel border border-line text-ink-2 hover:text-accent hover:border-accent/40 shadow-sm transition-all shrink-0 cursor-pointer disabled:opacity-50"
             >
               {chip}
             </button>
           ))}
         </div>
       )}

       {/* Composer */}
       <div className="p-3 border-t border-line bg-panel shrink-0 flex flex-col gap-2 shadow-sm">
         {errorMsg && (
           <div className="text-xs text-red bg-red-soft px-3 py-1.5 rounded-lg flex items-center justify-between">
             <span className="truncate">⚠️ {errorMsg}</span>
             <button onClick={() => setErrorMsg(null)} className="font-bold ml-2 hover:opacity-80">×</button>
           </div>
         )}
         <div className="relative flex items-end gap-2 bg-panel-2 border border-line rounded-xl p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10 transition-all shadow-inner">
           <textarea
             id="agent-stream-input"
             ref={textareaRef}
             rows={2}
             placeholder="Ask MioAgent to review your Base portfolio, flag risky tokens, or create a read-only recommendation..."
             value={input}
             onChange={e => setInput(e.target.value)}
             onKeyDown={e => {
               if (e.key === 'Enter' && !e.shiftKey) {
                 e.preventDefault();
                 handleSendMsg(input);
               }
             }}
             disabled={sendMessageMutation.isPending}
             className="w-full bg-transparent border-0 resize-none text-[13px] text-ink placeholder:text-ink-3 focus:outline-none max-h-32 min-h-[44px] py-1 leading-relaxed"
             aria-label="Agent Stream Instruction Input"
           />
           <button
             onClick={() => handleSendMsg(input)}
             disabled={!input.trim() || sendMessageMutation.isPending}
             className={`shrink-0 h-9 px-3.5 rounded-lg font-semibold text-xs flex items-center justify-center gap-1.5 transition-all shadow-sm ${
               !input.trim() || sendMessageMutation.isPending
                 ? 'bg-line text-ink-3 cursor-not-allowed'
                 : 'bg-accent text-white hover:bg-accent-2 cursor-pointer active:scale-[0.98]'
             }`}
             aria-label="Send message"
           >
             {sendMessageMutation.isPending ? (
               <span className="flex items-center gap-1.5">
                 <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                 <span>Sending...</span>
               </span>
             ) : (
               <>
                 <span>Send</span>
                 <span>↑</span>
               </>
             )}
           </button>
         </div>
         <div className="text-[11px] text-ink-3 flex items-center gap-1.5 px-1 font-medium">
           <span className="text-green shrink-0">🛡️</span>
           <span className="leading-snug">Read-only mode: MioAgent can create recommendations, but cannot execute mainnet transactions.</span>
         </div>
       </div>
    </aside>
  );
}

const COMMANDS = [
  { id: 'scan', icon: '⚡', label: 'Review tokens', tab: 'actions builder' },
  { id: 'scanner', icon: '📡', label: 'New scanner', tab: 'actions builder' },
  { id: 'positions', icon: '📈', label: 'Open positions', tab: 'main' },
  { id: 'memory', icon: '🧠', label: 'Edit memory', tab: 'history' },
  { id: 'keys', icon: '🔑', label: 'Session keys · autonomy', tab: 'configure' },
];



function ActionsBuilder({ showToast }: { showToast: (msg: string) => void }) {
  const { address } = useAccount();
  const [instruction, setInstruction] = useState('');
  const createAction = useCreateRecommendation();
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';

  const presets = [
    "Create a read-only swap plan for 0.1 ETH to USDC",
    "Create a recommendation to detect malicious token approvals",
    "Create a read-only portfolio rebalance report"
  ];

  const handleCreate = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    createAction.mutate({ instruction: trimmed, walletAddress: address, chainEnv: import.meta.env.VITE_CHAIN_ENV }, {
      onSuccess: () => {
        const toastMsg = isMainnetReadonly 
          ? 'Read-only recommendation created in Action Inbox' 
          : 'Testnet recommendation created in Action Inbox';
        showToast(toastMsg);
        setInstruction('');
      },
      onError: (e) => showToast('Failed to create: ' + e.message)
    });
  };

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Actions Builder</h2>
      <div className="bg-panel border border-line rounded-xl p-5 flex flex-col gap-4 shadow-sm">
         <div>
           <label className="text-sm font-bold text-ink flex justify-between items-center">
             <span>Instruction</span>
             <span className="text-xs font-normal text-ink-3">Natural language operation</span>
           </label>
           <textarea 
             value={instruction}
             onChange={e => setInstruction(e.target.value)}
             placeholder="e.g. Review my Base token list and flag risky assets" 
             className="w-full mt-2 border border-line rounded-lg p-3 text-sm bg-bg resize-none h-[100px] text-ink focus:outline-none focus:border-accent font-mono" 
           />
         </div>

         <div>
           <div className="text-xs font-bold uppercase text-ink-3 tracking-wider mb-2">Quick Presets</div>
           <div className="flex flex-col gap-1.5">
             {presets.map((preset, idx) => (
               <button
                 key={idx}
                 onClick={() => setInstruction(preset)}
                 className="text-left text-xs bg-bg/60 hover:bg-line/40 border border-line/60 rounded-lg p-2.5 text-ink-2 hover:text-ink transition-colors truncate"
               >
                 + {preset}
               </button>
             ))}
           </div>
         </div>

         <div className="flex flex-wrap gap-4 text-xs bg-bg p-3 rounded-lg border border-line text-ink-2">
           <div>Current mode: <span className="font-bold text-ink">{isMainnetReadonly ? 'Base Mainnet (Read-only)' : import.meta.env.VITE_CHAIN_ENV || 'sepolia'}</span></div>
           <div>Wallet: <span className="font-mono text-ink">{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Not connected'}</span></div>
           <div>Security: <span className="text-green font-bold">Action-Security Screening Enabled</span></div>
         </div>
         {isMainnetReadonly && (
           <div className="text-[11px] text-amber bg-amber-soft p-2.5 rounded-lg border border-amber/20 font-medium flex items-center gap-2">
             <span>🔒</span>
             <span>In Read-only mode, recommendations will be generated with execution blocked.</span>
           </div>
         )}

         {/* Action Preview Card */}
         <div className="bg-bg border border-line rounded-xl p-4 flex flex-col gap-3">
           <div className="text-xs font-bold uppercase text-ink-3 tracking-wider flex items-center justify-between">
             <span>Recommendation Preview</span>
             <span className="text-[10px] bg-panel px-2 py-0.5 rounded text-ink-2 font-mono">Live Preview</span>
           </div>
           {instruction.trim() ? (
             <div className="flex flex-col gap-2 text-xs">
               <div>
                 <span className="font-semibold text-ink-2">Reason: </span>
                 <span className="text-ink">{`Automated recommendation for: "${instruction.trim()}"`}</span>
               </div>
               <div className="flex flex-wrap gap-2 items-center">
                 <span className="font-semibold text-ink-2">Risk: </span>
                 <span className="px-2 py-0.5 rounded text-[11px] font-medium border bg-green-soft text-green border-green/20">
                   {isMainnetReadonly ? 'None (read-only mode)' : 'Low'}
                 </span>
               </div>
               <div>
                 <span className="font-semibold text-ink-2">Expected Effect: </span>
                 <span className="text-ink">{isMainnetReadonly ? 'Simulate action execution on mainnet-readonly' : `Simulate action execution on ${import.meta.env.VITE_CHAIN_ENV || 'sepolia'}`}</span>
               </div>
               <div className="flex flex-wrap gap-1.5 mt-1">
                 <span className="px-2 py-0.5 rounded text-[11px] font-medium border bg-panel text-ink-2 border-line">
                   Chain: {isMainnetReadonly ? 'mainnet-readonly' : 'sepolia'}
                 </span>
                 <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${isMainnetReadonly ? 'bg-red-soft text-red border-red/20' : 'bg-green-soft text-green border-green/20'}`}>
                   Safety: {isMainnetReadonly ? 'blocked - read only mode' : 'executable'}
                 </span>
               </div>
               <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${isMainnetReadonly ? 'bg-amber-soft text-amber border-amber/20' : 'bg-green-soft text-green border-green/20'}`}>
                 {isMainnetReadonly 
                   ? 'Read-only recommendation (execution disabled on mainnet)' 
                   : 'Executable testnet recommendation'}
               </div>
             </div>
           ) : (
             <div className="text-xs text-ink-3 italic py-2">
               Enter an instruction above or select a quick preset to see real-time recommendation preview.
             </div>
           )}
         </div>

         <div className="flex items-center justify-between pt-1">
           <button 
             disabled={!instruction.trim() || createAction.isPending}
             className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-2 shadow-[0_4px_12px_rgba(0,0,255,.2)] transition-all flex items-center gap-2" 
             onClick={handleCreate}
           >
             {createAction.isPending ? 'Creating recommendation...' : 'Create recommendation'}
           </button>
           <span className="text-xs text-ink-3">Generates structured action card in Inbox</span>
         </div>
      </div>
    </main>
  );
}

function HistoryPage() {
  const { data: chatData } = useChatHistory();
  const { data: actionsData } = useActionsFeed();
  const messages = chatData?.messages || [];
  const actions = actionsData?.actions || [];
  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">History</h2>
      <div className="flex gap-4">
        <div className="flex-1 bg-panel border border-line rounded-xl p-4">
           <h3 className="text-sm font-bold mb-3">Recent Messages</h3>
           <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto">
             {messages.map((m: any, i: number) => (
               <div key={i} className="text-sm p-2 bg-bg rounded border border-line">
                 <div className="text-xs text-ink-3 mb-1 font-bold">{m.role} <span className="font-normal">{new Date(m.createdAt || Date.now()).toLocaleTimeString()}</span></div>
                 {m.content}
               </div>
             ))}
             {messages.length === 0 && <div className="text-sm text-ink-3">No messages</div>}
           </div>
        </div>
        <div className="flex-1 bg-panel border border-line rounded-xl p-4">
           <h3 className="text-sm font-bold mb-3">Recent Actions</h3>
           <div className="flex flex-col gap-2.5 max-h-[400px] overflow-y-auto">
             {actions.map((a: any, i: number) => {
               const source = a.metadata?.createdBy || a.metadata?.source || 'system';
               const provider = a.metadata?.analysis?.provider || a.metadata?.provider || (a.kind === 'recommendation' ? 'moralis' : null);
               const statusBadge = a.status === 'executed' ? 'bg-green-soft text-green' : a.status === 'dismissed' ? 'bg-panel-2 text-ink-3' : a.status === 'failed' ? 'bg-red-soft text-red' : 'bg-amber-soft text-amber';

               return (
                 <div key={i} className="text-sm p-3 bg-bg rounded-lg border border-line flex flex-col gap-1.5 shadow-sm">
                   <div className="flex items-center justify-between text-xs">
                     <div className="flex items-center gap-2">
                       <span className="font-bold uppercase tracking-wider text-[11px] text-ink">{a.kind}</span>
                       <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize ${statusBadge}`}>{a.status}</span>
                     </div>
                     <span className="text-[11px] text-ink-3 font-mono">{new Date(a.createdAt).toLocaleString()}</span>
                   </div>
                   <div className="text-ink text-xs leading-relaxed font-medium">
                     {a.suggestedPrompt || a.metadata?.reason || 'Automated action'}
                   </div>
                   <div className="flex items-center justify-between text-[11px] text-ink-3 font-mono pt-1 border-t border-line/50">
                     <span>Source: <span className="text-ink-2 font-medium capitalize">{source}</span></span>
                     {provider && <span>Provider: <span className="text-ink-2 font-medium capitalize">{provider}</span></span>}
                   </div>
                 </div>
               );
             })}
             {actions.length === 0 && <div className="text-sm text-ink-3 text-center py-6">No actions recorded in history yet</div>}
           </div>
        </div>
      </div>
    </main>
  );
}

function ConfigurePage() {
  const { address } = useAccount();
  const { data: statusData } = useStatus();
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Configure</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-3">
         <div className="flex items-center justify-between py-1.5 border-b border-line">
           <span className="font-medium text-sm text-ink">Execution Mode</span>
           <div className="flex items-center gap-2">
             <span className="text-xs bg-panel-2 px-2.5 py-1 rounded border border-line font-mono text-ink">{statusData?.execution.mode || import.meta.env.VITE_CHAIN_ENV || 'sepolia'}</span>
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
           <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.tokenBalances.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.tokenBalances.status === 'failed' ? 'bg-red-soft text-red border-red/20' : 'bg-amber-soft text-amber border-amber/20'}`}>
             {statusData ? (
               statusData.tokenBalances.status === 'connected' ? `${statusData.tokenBalances.provider} connected` :
               statusData.tokenBalances.status === 'stale' ? `${statusData.tokenBalances.provider || 'moralis'} cached` :
               statusData.tokenBalances.status === 'failed' ? `${statusData.tokenBalances.provider || 'moralis'} failed` : 'Missing'
             ) : 'Checking...'}
           </span>
         </div>
         <div className="flex items-center justify-between py-1.5 border-b border-line">
           <span className="font-medium text-sm text-ink">Price Provider</span>
           <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.prices.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.prices.status === 'failed' ? 'bg-red-soft text-red border-red/20' : 'bg-amber-soft text-amber border-amber/20'}`}>
             {statusData ? (statusData.prices.status === 'connected' ? `${statusData.prices.provider} connected` : statusData.prices.status === 'failed' ? 'Price provider failed' : 'Missing') : 'Checking...'}
           </span>
         </div>
         <div className="flex items-center justify-between py-1.5 border-b border-line">
           <span className="font-medium text-sm text-ink">Risk / GoPlus Provider</span>
           <span className={`text-xs font-medium px-2.5 py-0.5 rounded border ${statusData?.risk.status === 'connected' ? 'bg-green-soft text-green border-green/20' : statusData?.risk.status === 'failed' ? 'bg-red-soft text-red border-red/20' : 'bg-amber-soft text-amber border-amber/20'}`}>
             {formatRiskProvider(statusData)}
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

function BaseMcpPage(_props: { showToast: (msg: string) => void }) {
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

function CommandPalette({ isOpen, onClose, onSelect }: { isOpen: boolean, onClose: () => void, onSelect: (tab: string) => void }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const filteredCommands = COMMANDS.filter(c => c.label.toLowerCase().includes(query.toLowerCase()) || c.id.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredCommands.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % filteredCommands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        onSelect(filteredCommands[selectedIndex].tab);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-ink/30 backdrop-blur-[3px] flex justify-center pt-[14vh] z-50 animate-in fade-in duration-150" onClick={onClose}>
       <div className="w-[560px] bg-panel rounded-[18px] shadow-lg overflow-hidden animate-in slide-in-from-bottom-4 duration-200" onClick={e => e.stopPropagation()}>
          <input
            type="text"
            placeholder="Command or search... 'swap', 'scanner', 'positions'"
            className="w-full border-none outline-none px-[20px] py-[18px] text-[16px] border-b border-line"
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="max-h-[340px] overflow-y-auto p-2">
             {filteredCommands.map((cmd, i) => (
               <div
                 key={cmd.id}
                 onClick={() => onSelect(cmd.tab)}
                 className={`flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer hover:bg-accent-soft ${selectedIndex === i ? 'bg-accent-soft' : ''}`}
               >
                  <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">{cmd.icon}</span>
                  {cmd.label}
                  {selectedIndex === i && <span className="ml-auto font-mono text-[11px] text-ink-3">↵</span>}
               </div>
             ))}
             {filteredCommands.length === 0 && (
               <div className="px-[13px] py-[11px] text-[14px] text-ink-3">No commands</div>
             )}
          </div>
          <div className="px-[16px] py-[9px] border-t border-line text-[11px] text-ink-3 flex gap-[14px] font-mono">
             <span>↑↓ navigate</span>
             <span>↵ select</span>
             <span>esc to close</span>
          </div>
       </div>
    </div>
  );
}

function Toast({ msg }: { msg: string }) {
     if (!msg) return null;
     return (
       <div className="fixed bottom-[22px] left-1/2 -translate-x-1/2 bg-ink text-white px-[18px] py-[12px] rounded-[12px] text-[13px] font-medium flex items-center gap-[9px] z-[60] shadow-lg animate-in slide-in-from-bottom-4">
         <span className="w-[9px] h-[9px] rounded-full bg-green"></span>
         {msg}
       </div>
     );
   }

   function App() {
     const [toastMsg, setToastMsg] = useState("");
     const showToast = (msg: string) => {
       setToastMsg(msg);
       setTimeout(() => setToastMsg(""), 3200);
     };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('main');

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(open => !open);
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  return (
    <div className="h-screen w-full flex flex-col font-sans">
      <TopBar showToast={showToast} activeTab={activeTab} setActiveTab={setActiveTab} onOpenCommand={() => setPaletteOpen(true)} />
      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'main' && (
           <>
             <LeftRail showToast={showToast} />
             <ActionInbox showToast={showToast} onSelectTab={setActiveTab} />
             <AgentStream showToast={showToast} onSelectTab={setActiveTab} />
           </>
        )}
        {activeTab === 'actions builder' && <ActionsBuilder showToast={showToast} />}
        {activeTab === 'history' && <HistoryPage />}
        {activeTab === 'configure' && <ConfigurePage />}
        {activeTab === 'base mcp' && <BaseMcpPage showToast={showToast} />}
      </div>
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(tab) => {
          setActiveTab(tab);
          setPaletteOpen(false);
        }}
      />
      <Toast msg={toastMsg} />
    </div>
  );
}

export default App;
