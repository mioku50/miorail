import { useState, useRef, useEffect } from 'react';
import { usePortfolio, useActionsFeed, useChatHistory, useSendMessage, useProtocols, useToggleProtocol, useExecuteAction, useDismissAction } from '@mioagent/api-client-react';

function TopBar({ onOpenCommand }: { onOpenCommand: () => void }) {
  const [activeTab, setActiveTab] = useState('main');
  const tabs = ['main', 'actions builder', 'history', 'configure', 'base mcp'];

  return (
    <header className="h-[56px] flex items-center px-[18px] bg-panel border-b border-line gap-4">
      <div className="flex items-center gap-2 font-bold text-ink">
        <div className="w-[26px] h-[26px] rounded-lg bg-accent text-white flex items-center justify-center text-sm">◆</div>
        <span>Base Agent</span>
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
        4 сканера активны · тик через <span className="font-mono ml-1">0:42</span>
      </div>

      <button
        onClick={onOpenCommand}
        className="flex items-center gap-2 bg-bg border border-line px-[12px] py-[7px] rounded-[10px] text-ink-3 text-[13px] hover:bg-line/50 transition-colors"
      >
        Команда
        <kbd className="font-mono bg-white border border-line rounded-[6px] px-[6px] py-[1px] text-[11px] text-ink-2 shadow-sm">
          ⌘K
        </kbd>
      </button>

      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-accent to-accent-2 shadow-sm ml-2"></div>
    </header>
  );
}

function LeftRail() {
  const { data: portfolio, isError: isPortfolioError } = usePortfolio();
  const { data: protocolsData, isError: isProtocolsError } = useProtocols();
  const { mutate: toggleProtocol } = useToggleProtocol();

  const tokens = portfolio?.tokens || [];
  const usdcBalance = tokens.find((b: { symbol: string; balanceFormatted: string }) => b.symbol === 'USDC')?.balanceFormatted || '0.00';
  const displayAddress = '0x84f5…834b';

  return (
    <aside className="w-[320px] min-w-[280px] border-r border-line bg-panel-2 p-4 flex flex-col gap-[14px] overflow-y-auto">
      {/* Portfolio Card */}
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-[11px] flex items-center justify-between">
          Портфель
          {!isPortfolioError && portfolio && <span className="bg-green-soft text-green px-2 py-0.5 rounded text-[10px] lowercase tracking-normal">+4.2%</span>}
        </div>

        {isPortfolioError || !portfolio ? (
           <div className="text-[13px] text-ink-3 italic py-4">Not connected</div>
        ) : (
          <>
            <div className="flex items-baseline mb-4">
              <div className="text-[30px] font-bold tracking-tight font-mono text-ink">${usdcBalance}</div>
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
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3">Автономия</div>
          <span className="text-[10px] font-bold text-accent bg-accent-soft px-[7px] py-[2px] rounded-[6px] tracking-[.05em]">SESSION KEY</span>
        </div>
        <div className="text-[13px] text-ink-3 italic py-2">Coming soon</div>
      </div>

      {/* x402 Budget */}
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">x402 бюджет</div>
        <div className="text-[13px] text-ink-3 italic py-2">Coming soon</div>
      </div>

      {/* Protocols */}
      <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
        <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">Протоколы</div>
        {isProtocolsError || !protocolsData ? (
           <div className="text-[13px] text-ink-3 italic py-2">Not connected</div>
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

function ActionInbox() {
  const { data, isLoading, refetch } = useActionsFeed();
  const executeAction = useExecuteAction();
  const dismissAction = useDismissAction();

  const actions = data?.actions || [];

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[16px] font-bold text-ink tracking-[-.02em]">Action Inbox</h2>
        <div className="flex gap-1.5">
          {['все', 'сигналы', 'рекомендации', 'blocked'].map((f, i) => (
            <div key={f} className={`px-[11px] py-[5px] rounded-[9px] text-[12px] font-medium border cursor-pointer ${i === 0 ? 'bg-accent text-white border-accent' : 'bg-panel text-ink-2 border-line hover:bg-bg'}`}>
              {f}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {isLoading && <div className="text-sm text-ink-3">Загрузка...</div>}
        {!isLoading && actions.length === 0 && (
          <div className="text-sm text-ink-3">Нет активных действий</div>
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
                     <button
                       onClick={() => executeAction.mutate({ actionId: action.id }, { onSuccess: () => refetch() })}
                       disabled={!isPending || isExecuting || isDismissing}
                       className="bg-accent hover:bg-accent-2 text-white px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] shadow-[0_6px_16px_rgba(0,0,255,.28)] hover:-translate-y-[1px] hover:shadow-[0_10px_22px_rgba(0,0,255,.34)] transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       ⚡ {isExecuting ? 'Executing...' : 'Execute'}
                     </button>
                     <button
                       onClick={() => dismissAction.mutate({ actionId: action.id }, { onSuccess: () => refetch() })}
                       disabled={!isPending || isExecuting || isDismissing}
                       className="bg-bg hover:bg-[#eceef7] text-ink-2 px-[15px] py-[9px] rounded-[11px] font-semibold text-[13px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                     >
                       {isDismissing ? 'Dismissing...' : 'Скрыть'}
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

function AgentStream() {
  const { data: chatData, refetch } = useChatHistory();
  const sendMessageMutation = useSendMessage();
  const [input, setInput] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  const [simState, setSimState] = useState<'idle'|'simulating'|'done'|'approved'>('idle');

  const messages = chatData?.messages || [];

  const displayMessages = messages.length > 0 ? messages : [
    { role: 'user', content: 'swap a small starter position of USDC for NOCK on base' }
  ];

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [displayMessages, simState]);

  const handleSend = async () => {
    if (!input.trim() || sendMessageMutation.isPending) return;
    const msg = input;
    setInput('');
    try {
      await sendMessageMutation.mutateAsync({ message: msg });
      refetch();
    } catch {
      // simulate demo flow if backend fails or doesn't support chat yet
      setSimState('simulating');
      setTimeout(() => setSimState('done'), 1500);
    }
  };

  return (
    <aside className="w-[380px] bg-panel-2 border-l border-line flex flex-col">
       <div className="p-4 flex flex-col h-full">
         <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3 flex justify-between items-center">
            Agent Stream
            <span className="font-mono text-accent normal-case font-normal cursor-pointer hover:underline">+ new chat</span>
         </div>

         <div className="flex-1 overflow-y-auto flex flex-col gap-[11px] pr-1 pb-4" ref={streamRef}>
            {displayMessages.map((m: any /* eslint-disable-line @typescript-eslint/no-explicit-any */, i: number) => (
               <div key={i} className={`text-[13px] leading-relaxed ${m.role === 'user' ? 'self-end bg-accent text-white px-[13px] py-[9px] rounded-t-[14px] rounded-bl-[14px] rounded-br-[4px] max-w-[85%]' : 'bg-panel border border-line px-3 py-2 rounded-lg'}`}>
                 {m.content}
               </div>
            ))}

            {/* Mocking the tool calls and sim card if we triggered it via demo */}
            {(simState !== 'idle' || messages.length === 0) && (
              <>
                 <div className="bg-panel border border-line rounded-[12px] px-[12px] py-[9px] font-mono text-[12px] flex items-center gap-[9px] text-ink-2">
                   <span className="text-green font-bold">✓</span> search_tokens <span className="text-ink-3">{"{\"q\":\"NOCK\"}"}</span>
                 </div>
                 <div className="bg-panel border border-line rounded-[12px] px-[12px] py-[9px] font-mono text-[12px] flex items-center gap-[9px] text-ink-2">
                   <span className="text-green font-bold">✓</span> get_portfolio <span className="text-ink-3">{"{\"chain\":\"base\"}"}</span>
                 </div>
                 <div className="text-[11px] text-ink-3 flex items-center gap-1 font-mono">
                    🔒 screened · инструкция проверена action-security
                 </div>
              </>
            )}

            {simState === 'simulating' && (
               <div className="bg-panel border border-line rounded-[12px] px-[12px] py-[9px] font-mono text-[12px] flex items-center gap-[9px] text-ink-2">
                 <span className="text-accent animate-pulse">●</span> swap <span className="text-ink-3">симуляция…</span>
               </div>
            )}

            {simState === 'done' || simState === 'approved' ? (
               <>
                 <div className="bg-panel border border-line rounded-[12px] px-[12px] py-[9px] font-mono text-[12px] flex items-center gap-[9px] text-ink-2">
                   <span className="text-green font-bold">✓</span> swap <span className="text-ink-3">simulated</span>
                 </div>

                 <div className="border border-accent-soft bg-[#fafaff] rounded-[14px] p-[13px] flex flex-col gap-[10px] animate-in fade-in slide-in-from-bottom-2">
                    <h4 className="text-[12px] tracking-[.05em] uppercase text-accent flex items-center gap-[7px] font-bold">
                       ◆ Pre-trade simulation
                    </h4>
                    <div className="flex flex-col gap-[7px]">
                       <div className="flex justify-between text-[12px]">
                         <span className="text-ink-2">Исход</span>
                         <span className="font-mono font-bold">5 USDC → ~7,810 NOCK</span>
                       </div>
                       <div className="flex justify-between text-[12px]">
                         <span className="text-ink-2">Slippage</span>
                         <span className="font-mono font-bold text-amber">5.0%</span>
                       </div>
                       <div className="flex justify-between text-[12px]">
                         <span className="text-ink-2">Эффект на портфель</span>
                         <span className="font-mono font-bold text-green">+0.04%</span>
                       </div>
                       <div className="flex justify-between text-[12px]">
                         <span className="text-ink-2">Газ (Base)</span>
                         <span className="font-mono font-bold">~$0.001</span>
                       </div>
                    </div>
                    <div className="flex items-center gap-[7px] text-[12px] font-bold text-green bg-green-soft px-[10px] py-[6px] rounded-[9px]">
                       🛡️ GoPlus: безопасно · не honeypot
                    </div>
                    <div className="bg-ink text-white rounded-[12px] p-[12px] flex flex-col gap-[9px]">
                       <div className="flex justify-between text-[12px] font-mono text-[#c7c9d6]">
                          <span>x402 стоимость действия</span>
                          <b className="text-white">$0.004</b>
                       </div>
                       <div className="flex justify-between text-[12px] font-mono text-[#c7c9d6]">
                          <span>подпись</span>
                          <b className="text-white">session key (в лимите)</b>
                       </div>
                       <button
                         onClick={() => setSimState('approved')}
                         className={`w-full py-[11px] rounded-[10px] font-bold text-[13px] transition-all ${simState === 'approved' ? 'bg-green' : 'bg-accent'}`}
                       >
                         {simState === 'approved' ? '✓ Подтверждено за 0.8с' : 'Open Base app to approve →'}
                       </button>
                    </div>
                 </div>
               </>
            ) : null}

         </div>

         <div className="mt-3 flex gap-2 items-center bg-panel border border-line rounded-[14px] px-[8px] py-[8px] pl-[14px] shadow-sm">
            <input
              type="text"
              className="flex-1 border-none outline-none text-[13px] bg-transparent font-sans"
              placeholder="Дайте инструкцию агенту…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              disabled={sendMessageMutation.isPending || simState === 'simulating'}
            />
            <button
              onClick={handleSend}
              disabled={sendMessageMutation.isPending || simState === 'simulating'}
              className="w-[34px] h-[34px] bg-accent text-white rounded-[10px] flex items-center justify-center text-[15px] hover:bg-accent-2 transition-colors disabled:opacity-50"
            >
              ↑
            </button>
         </div>
       </div>
    </aside>
  );
}

function CommandPalette({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-ink/30 backdrop-blur-[3px] flex justify-center pt-[14vh] z-50 animate-in fade-in duration-150" onClick={onClose}>
       <div className="w-[560px] bg-panel rounded-[18px] shadow-lg overflow-hidden animate-in slide-in-from-bottom-4 duration-200" onClick={e => e.stopPropagation()}>
          <input
            type="text"
            placeholder="Команда или поиск…  «swap», «scanner», «positions»"
            className="w-full border-none outline-none px-[20px] py-[18px] text-[16px] border-b border-line"
            autoFocus
          />
          <div className="max-h-[340px] overflow-y-auto p-2">
             <div className="flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer hover:bg-accent-soft bg-accent-soft">
                <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">⚡</span>
                Swap токены
                <span className="ml-auto font-mono text-[11px] text-ink-3">↵</span>
             </div>
             <div className="flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer hover:bg-accent-soft">
                <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">📡</span>
                Новый сканер
             </div>
             <div className="flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer hover:bg-accent-soft">
                <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">📈</span>
                Открытые позиции
             </div>
             <div className="flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer hover:bg-accent-soft">
                <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">🧠</span>
                Редактировать память
             </div>
             <div className="flex items-center gap-[12px] px-[13px] py-[11px] rounded-[11px] text-[14px] cursor-pointer hover:bg-accent-soft">
                <span className="w-[28px] h-[28px] rounded-[8px] bg-bg flex items-center justify-center text-[14px]">🔑</span>
                Session keys · автономия
             </div>
          </div>
          <div className="px-[16px] py-[9px] border-t border-line text-[11px] text-ink-3 flex gap-[14px] font-mono">
             <span>↑↓ навигация</span>
             <span>↵ выбрать</span>
             <span>esc закрыть</span>
          </div>
       </div>
    </div>
  );
}

function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);

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
      <TopBar onOpenCommand={() => setPaletteOpen(true)} />
      <div className="flex-1 flex overflow-hidden">
        <LeftRail />
        <ActionInbox />
        <AgentStream />
      </div>
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

export default App;
