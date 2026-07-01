import { useState, useRef, useEffect } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { usePortfolio, useActionsFeed, useChatHistory, useSendMessage, useProtocols, useToggleProtocol, useExecuteAction, useDismissAction, useClearChatHistory, useClearActions, useCreateRecommendation } from '@mioagent/api-client-react';


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

function LeftRail({ showToast }: { showToast: (msg: string) => void }) {
  const { address } = useAccount();
  const { data: portfolio, isError: isPortfolioError, error: portfolioError } = usePortfolio(address);
  const { data: protocolsData, isError: isProtocolsError } = useProtocols();
  const { mutate: toggleProtocol } = useToggleProtocol();

  const tokens = portfolio?.tokens || [];
  const ethToken = tokens.find((b: any) => b.symbol === 'ETH');
  const ethBalance = ethToken?.balanceFormatted || '0.00';
  const usdcToken = tokens.find((b: any) => b.symbol === 'USDC');
  const usdcBalance = usdcToken?.balanceFormatted;
  const displayAddress = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';

  return (
    <aside className="w-[320px] min-w-[280px] border-r border-line bg-panel-2 p-4 flex flex-col gap-[14px] overflow-y-auto">
      {/* Portfolio Card */}
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-[11px] flex items-center justify-between">
          Portfolio
          {!isPortfolioError && portfolio && <span className="bg-green-soft text-green px-2 py-0.5 rounded text-[10px] lowercase tracking-normal">+4.2%</span>}
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
            {portfolio.providerStatus && (
              <div className="text-[11px] text-amber bg-amber-soft p-2 rounded border border-amber/20 mb-3 font-medium">
                {portfolio.providerStatus}
              </div>
            )}
            <div className="flex items-baseline mb-4 flex-col">
              <div className="text-[30px] font-bold tracking-tight font-mono text-ink">{ethBalance} <span className="text-[16px] text-ink-2">ETH</span></div>
              {usdcBalance && !isMainnetReadonly && (
                 <div className="text-[20px] font-bold tracking-tight font-mono text-ink mt-1">{usdcBalance} <span className="text-[14px] text-ink-2">testnet-USDC</span></div>
              )}
            </div>

            <svg className="w-full h-[46px] mb-2" viewBox="0 0 240 46" preserveAspectRatio="none">
              <defs>
                <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#0000FF" stopOpacity=".22"/>
                  <stop offset="1" stopColor="#0000FF" stopOpacity="0"/>
                </linearGradient>
              </defs>
              <path d="M0,34 L20,30 L40,33 L60,24 L80,27 L100,18 L120,22 L140,12 L160,17 L180,9 L200,14 L220,6 L240,10"
                fill="none" stroke="#0000FF" strokeWidth="2" strokeLinejoin="round"/>
              <path d="M0,34 L20,30 L40,33 L60,24 L80,27 L100,18 L120,22 L140,12 L160,17 L180,9 L200,14 L220,6 L240,10 L240,46 L0,46 Z" fill="url(#g)"/>
            </svg>

            <div className="font-mono text-[12px] text-ink-3 mt-2 flex items-center gap-1.5">
              ⬡ {displayAddress} <span className="text-accent cursor-pointer ml-auto hover:underline">manage in base ↗</span>
            </div>

            <div className="mt-4 flex flex-col gap-2">
               {tokens.map((token: any, idx: number) => (
                  <div key={idx} className="flex justify-between items-center text-[13px]">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-[#2775ca] text-white flex items-center justify-center text-[10px] font-bold">
                         {token.symbol[0]}
                      </span>
                      <span className="font-medium text-ink">{token.symbol}</span>
                    </div>
                    <span className="font-mono font-medium">{token.balanceFormatted}</span>
                  </div>
               ))}
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
               {address ? <span className="text-green font-medium">Connected</span> : <span className="text-amber font-medium">Missing</span>}
             </div>
             <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
               <span className="text-ink-2">Token balances</span>
               <span className="text-amber font-medium">Missing</span>
             </div>
             <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
               <span className="text-ink-2">GoPlus</span>
               <span className="text-amber font-medium">Missing</span>
             </div>
             <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
               <span className="text-ink-2">DeFiLlama/CoinGecko</span>
               <span className="text-amber font-medium">Missing</span>
             </div>
             <div className="flex items-center justify-between py-1 text-[12px]">
               <span className="text-ink-2">Base MCP</span>
               {import.meta.env.VITE_MCP_SERVER_URL ? <span className="text-green font-medium">Configured</span> : <span className="text-red font-medium">Missing</span>}
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

function ActionInbox({ showToast }: { showToast: (msg: string) => void }) {
  const { data, isLoading, refetch } = useActionsFeed();
  const executeAction = useExecuteAction();
  const dismissAction = useDismissAction();
  const clearActions = useClearActions();
  const isMainnetReadonly = import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly';

  const actions = data?.actions || [];

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[16px] font-bold text-ink tracking-[-.02em]">Action Inbox</h2>
        <div className="flex gap-1.5">
          {['all', 'signals', 'recommendations', 'blocked'].map((f, i) => (
            <div key={f} className={`px-[11px] py-[5px] rounded-[9px] text-[12px] font-medium border cursor-pointer ${i === 0 ? 'bg-accent text-white border-accent' : 'bg-panel text-ink-2 border-line hover:bg-bg'}`}>
              {f}
            </div>
          ))}
                  <button onClick={() => { if(confirm('Clear demo actions?')) clearActions.mutate(); }} disabled={clearActions.isPending} className="px-2 py-1 bg-red-soft text-red text-xs rounded border border-red/20 ml-2 hover:bg-red hover:text-white transition-colors">Clear demo actions</button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading && <div className="text-sm text-ink-3">Loading...</div>}
        {!isLoading && actions.length === 0 && (
          <div className="text-sm text-ink-3">No active actions</div>
        )}
        {actions.map((action: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) => {
           const isPending = action.status === 'pending';
           const isExecuting = executeAction.isPending && executeAction.variables?.actionId === action.id;
           const isDismissing = dismissAction.isPending && dismissAction.variables?.actionId === action.id;

           return (
             <div key={action.id} className={`bg-panel border rounded-xl shadow-sm p-[15px] flex flex-col gap-[10px] animate-in fade-in slide-in-from-bottom-2 ${action.status === 'failed' ? 'border-red-soft' : 'border-line'}`}>
                <div className="flex items-start justify-between gap-[10px]">
                   <div className="flex gap-[10px]">
                      <div className={`w-[9px] h-[9px] rounded-full shrink-0 mt-[5px] ${action.status === 'executed' ? 'bg-green' : action.status === 'pending' ? 'bg-amber' : 'bg-red'}`}></div>
                      <div>
                         <h3 className="text-[15px] font-bold text-ink tracking-[-.01em] uppercase">{action.kind}</h3>
                         <div className="font-mono text-[11px] text-ink-3 mt-1">real-backend</div>
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
                  <div className="flex gap-2 items-center mt-1">
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
                       disabled={!isPending || isExecuting || isDismissing || isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet'}
                       className="bg-accent hover:bg-accent-2 text-white px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] shadow-[0_6px_16px_rgba(0,0,255,.28)] hover:-translate-y-[1px] hover:shadow-[0_10px_22px_rgba(0,0,255,.34)] transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       ⚡ {isExecuting ? 'Executing...' : (isMainnetReadonly || action.metadata?.chainMode === 'mainnet-readonly' || action.metadata?.chainMode === 'mainnet') ? 'Read-only' : 'Execute'}
                     </button>
                     </span>
                     <button
                       onClick={() => dismissAction.mutate({ actionId: action.id }, { onSuccess: () => refetch() })}
                       disabled={!isPending || isExecuting || isDismissing}
                       className="bg-bg hover:bg-[#eceef7] text-ink-2 px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       {isDismissing ? 'Dismissing...' : 'Dismiss'}
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

function AgentStream({ showToast }: { showToast: (msg: string) => void }) {
  const { data: chatData, refetch } = useChatHistory();
  const sendMessageMutation = useSendMessage();
  const clearChat = useClearChatHistory();
  const [input, setInput] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  

  const messages = chatData?.messages || [];
  const displayMessages = messages;

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [displayMessages]);

  const handleSend = async () => {
    if (!input.trim() || sendMessageMutation.isPending) return;
    const msg = input;
    setInput('');
    try {
      await sendMessageMutation.mutateAsync({ message: msg });
      refetch();
    } catch (err: any) {
      console.error(err);
      showToast('Error: ' + err.message);
    }
  };

  return (
    <div className="chat">
       <div className="chat-head">
         Agent Stream
         <span className="mono" style={{color:'var(--color-accent)', cursor:'pointer'}} onClick={() => { if(confirm('Clear chat history?')) clearChat.mutate(); }}>+ new chat</span>
       </div>

       <div className="stream" ref={streamRef}>
          {displayMessages.length === 0 && (
             <div style={{display:'flex', alignItems:'center', justifyContent:'center', fontSize:'14px', color:'var(--color-ink-3)', height:'100%'}}>
               Send a message to start...
             </div>
          )}

          {displayMessages.map((m: any, i: number) => {
            if (m.role === 'user') {
              return (
                <div key={i} className="msg user">
                  {m.content}
                </div>
              );
            }
            if (m.role === 'assistant') {
              if (m.content) {
                 return (
                   <div key={i} className="msg" style={{background:'var(--color-panel)', border:'1px solid var(--color-line)', padding:'9px 13px', borderRadius:'4px 14px 14px 14px'}}>
                     {m.content}
                   </div>
                 );
              }
              if (m.toolCalls && m.toolCalls.length > 0) {
                 return (
                   <div key={i} style={{display:'flex', flexDirection:'column', gap:'8px', width:'100%'}}>
                     {m.toolCalls.map((tc: any, idx: number) => (
                       <div key={idx} className="toolcall">
                          <span className="ok">✓</span> {tc.name} <span style={{color:'var(--color-ink-3)'}}>{JSON.stringify(tc.arguments)}</span>
                       </div>
                     ))}
                   </div>
                 );
              }
            }
            return null;
          })}

          

       </div>

       <div className="composer">
          <input
            type="text"
            placeholder="Give the agent an instruction..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            disabled={sendMessageMutation.isPending}
          />
          <button
            onClick={handleSend}
            disabled={sendMessageMutation.isPending}
            className="send"
          >
            ↑
          </button>
       </div>
    </div>
  );
}

const COMMANDS = [
  { id: 'swap', icon: '⚡', label: 'Swap tokens', tab: 'actions builder' },
  { id: 'scanner', icon: '📡', label: 'New scanner', tab: 'actions builder' },
  { id: 'positions', icon: '📈', label: 'Open positions', tab: 'main' },
  { id: 'memory', icon: '🧠', label: 'Edit memory', tab: 'history' },
  { id: 'keys', icon: '🔑', label: 'Session keys · autonomy', tab: 'configure' },
];



function ActionsBuilder({ showToast }: { showToast: (msg: string) => void }) {
  const { address } = useAccount();
  const [instruction, setInstruction] = useState('');
  const createAction = useCreateRecommendation();

  const handleCreate = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    createAction.mutate({ instruction: trimmed }, {
      onSuccess: () => {
        showToast('Recommendation created in Action Inbox');
        setInstruction('');
      },
      onError: (e) => showToast('Failed to create: ' + e.message)
    });
  };

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Actions Builder</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
         <div>
           <label className="text-sm font-medium text-ink-2">Instruction</label>
           <textarea 
             value={instruction}
             onChange={e => setInstruction(e.target.value)}
             placeholder="e.g. swap 1 USDC to ETH..." 
             className="w-full mt-2 border border-line rounded-md p-2 text-sm bg-bg resize-none h-[100px] text-ink" 
           />
         </div>
         <div className="text-sm text-ink-2">Current mode: <span className="font-medium text-ink">{import.meta.env.VITE_CHAIN_ENV || 'sepolia'}</span></div>
         <div className="text-sm text-ink-2">Wallet: <span className="font-mono text-ink">{address || 'Not connected'}</span></div>
         <button 
           disabled={!instruction.trim() || createAction.isPending}
           className="bg-accent text-white px-4 py-2 rounded-lg text-sm w-fit font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors" 
           onClick={handleCreate}
         >
           {createAction.isPending ? 'Creating...' : 'Create recommendation'}
         </button>
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
           <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto">
             {actions.map((a: any, i: number) => (
               <div key={i} className="text-sm p-2 bg-bg rounded border border-line">
                 <div className="text-xs text-ink-3 mb-1 font-bold">{a.kind} · {a.status} <span className="font-normal">{new Date(a.createdAt).toLocaleTimeString()}</span></div>
                 {a.suggestedPrompt}
               </div>
             ))}
             {actions.length === 0 && <div className="text-sm text-ink-3">No actions</div>}
           </div>
        </div>
      </div>
    </main>
  );
}

function ConfigurePage() {
  const { address } = useAccount();
  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Configure</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
         <div className="flex items-center gap-2">
           <span className="font-medium text-sm w-[150px]">Network Mode</span>
           <span className="text-xs bg-panel-2 px-2 py-1 rounded border border-line">{import.meta.env.VITE_CHAIN_ENV || 'sepolia'}</span>
           {import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly' && <span className="text-xs text-amber font-medium">Mainnet execution is disabled in read-only mode</span>}
         </div>
         <div className="flex items-center gap-2">
           <span className="font-medium text-sm w-[150px]">Connected Wallet</span>
           <span className="text-xs bg-panel-2 px-2 py-1 rounded border border-line font-mono">{address || 'None'}</span>
         </div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm w-[150px]">RPC Provider</span>
            <span className="text-xs text-green font-medium">Configured</span>
          </div>
         <div className="flex items-center gap-2">
           <span className="font-medium text-sm w-[150px]">LLM Provider</span>
           <span className="text-xs text-green font-medium">Configured</span>
         </div>
         <div className="flex items-center gap-2">
           <span className="font-medium text-sm w-[150px]">x402 Micropayments</span>
           <span className="text-xs text-amber font-medium">Simulated</span>
         </div>
      </div>
    </main>
  );
}

function BaseMcpPage(_props: { showToast: (msg: string) => void }) {
  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">Base MCP Status</h2>
      <div className="bg-panel border border-line rounded-xl p-4 flex flex-col gap-4">
         <div className="flex flex-col gap-1">
           <span className="font-medium text-sm">Server URL</span>
           <span className="text-xs text-ink-3 font-mono">{import.meta.env.VITE_MCP_SERVER_URL ? 'Configured (Env)' : 'Missing'}</span>
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
             <ActionInbox showToast={showToast} />
             <AgentStream showToast={showToast} />
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
