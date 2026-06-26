import { Terminal, Shield, Activity, Wallet, Bot, Zap } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { usePortfolio, useActionsFeed, useProtocols, useChatHistory, useSendMessage, useExecuteAction, useDismissAction } from '@mioagent/api-client-react';

function TopBar() {
  return (
    <header className="h-14 border-b border-[#262626] bg-[#141414] px-4 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Terminal className="text-[#0052FF]" size={20} />
        <span className="font-bold text-sm tracking-wide">MIOAGENT</span>
        <span className="px-2 py-0.5 ml-2 bg-[#262626] rounded text-xs text-[#A3A3A3] font-mono">
          COMMAND DECK
        </span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-xs text-[#A3A3A3]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          Agent Pulse: Active
        </div>
        <button className="flex items-center gap-2 px-3 py-1.5 bg-[#262626] hover:bg-[#333] rounded-md text-sm text-[#A3A3A3] transition-colors">
          <span>Search...</span>
          <kbd className="font-mono text-[10px] bg-[#1a1a1a] px-1.5 py-0.5 rounded border border-[#333]">⌘K</kbd>
        </button>
      </div>
    </header>
  );
}

function LeftRail() {
  const { data: portfolio } = usePortfolio();
  const { data: protocols } = useProtocols();

  const tokens = portfolio?.tokens || [];
  const usdcBalance = tokens.find((b: any) => b.symbol === 'USDC')?.balanceFormatted || '0.00';
  // Use a fallback connected address since the API might not expose the root address directly in tokens array
  const displayAddress = '0x8F3...9A2C';

  return (
    <aside className="w-64 border-r border-[#262626] bg-[#0A0A0A] p-4 flex flex-col gap-6">
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-[#A3A3A3] uppercase tracking-wider flex items-center gap-2">
          <Wallet size={14} /> Wallet
        </h2>
        <div className="bg-[#141414] p-3 rounded-lg border border-[#262626]">
          <div className="text-2xl font-mono font-medium">${usdcBalance}</div>
          <div className="text-xs text-[#A3A3A3] font-mono mt-1">{displayAddress}</div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-[#A3A3A3] uppercase tracking-wider flex items-center gap-2">
          <Shield size={14} /> Autonomy
        </h2>
        <div className="bg-[#141414] p-3 rounded-lg border border-[#262626] space-y-2">
          <div className="flex justify-between items-center text-sm">
            <span className="text-[#A3A3A3]">Session Key</span>
            <span className="text-emerald-500 text-xs">Active</span>
          </div>
          <div className="h-1 bg-[#262626] rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 w-1/4"></div>
          </div>
          <div className="flex justify-between text-xs text-[#A3A3A3] font-mono">
            <span>$0.00 spent</span>
            <span>$50 limit</span>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-[#A3A3A3] uppercase tracking-wider flex items-center gap-2">
          <Activity size={14} /> Protocols
        </h2>
        <div className="space-y-2 text-sm">
          {protocols?.protocols ? protocols.protocols.map((p) => (
            <div key={p.id} className="flex items-center justify-between p-2 hover:bg-[#141414] rounded-md cursor-pointer transition-colors">
              <span className="text-[#EDEDED]">{p.name}</span>
              <span className={`text-xs font-mono ${p.enabled ? 'text-emerald-500' : 'text-[#A3A3A3]'}`}>
                {p.enabled ? 'ON' : 'OFF'}
              </span>
            </div>
          )) : (
            <div className="text-xs text-[#A3A3A3]">Loading protocols...</div>
          )}
        </div>
      </section>
    </aside>
  );
}

function ActionInbox() {
  const { data, refetch } = useActionsFeed();
  const executeMutation = useExecuteAction();
  const dismissMutation = useDismissAction();

  const actions = data?.actions || [];

  const handleExecute = async (actionId: string) => {
    await executeMutation.mutateAsync({ actionId });
    refetch();
  };

  const handleDismiss = async (actionId: string) => {
    await dismissMutation.mutateAsync({ actionId });
    refetch();
  };

  return (
    <main className="flex-1 border-r border-[#262626] bg-[#0A0A0A] flex flex-col">
      <header className="h-12 border-b border-[#262626] flex items-center px-4 bg-[#141414]/50">
        <h1 className="text-sm font-semibold">ACTION INBOX</h1>
      </header>
      <div className="p-4 flex flex-col gap-4 overflow-y-auto">
        {actions.length === 0 && (
          <div className="text-center text-sm text-[#A3A3A3] mt-10">No pending actions.</div>
        )}
        {actions.map(action => (
          <div key={action.id} className="bg-[#141414] border border-[#262626] rounded-lg p-4 space-y-3">
             <div className="flex justify-between items-start">
              <div className="flex items-center gap-2 text-emerald-500 text-xs font-medium">
                <Zap size={14} /> {action.kind.toUpperCase()}
              </div>
              <span className="text-xs text-[#A3A3A3]">{new Date(action.createdAt).toLocaleTimeString()}</span>
            </div>
            <p className="text-sm">{action.suggestedPrompt || 'Action recommendation'}</p>
            <div className="flex gap-2">
              <button
                onClick={() => handleDismiss(action.id)}
                disabled={dismissMutation.isPending}
                className="px-3 py-1.5 bg-[#262626] hover:bg-[#333] text-xs rounded-md font-medium transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={() => handleExecute(action.id)}
                disabled={executeMutation.isPending}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-xs text-white rounded-md font-medium transition-colors group flex items-center gap-1"
              >
                {executeMutation.isPending ? 'Executing...' : 'Execute'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function AgentStream() {
  const { data: chatData, refetch } = useChatHistory();
  const sendMessageMutation = useSendMessage();
  const [input, setInput] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);

  const messages = chatData?.messages || [];

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sendMessageMutation.isPending) return;
    const msg = input;
    setInput('');
    // Use `message` field per api-spec instead of `content`
    await sendMessageMutation.mutateAsync({ message: msg });
    refetch();
  };

  return (
    <aside className="w-[400px] bg-[#0A0A0A] flex flex-col">
       <header className="h-12 border-b border-[#262626] flex items-center px-4 bg-[#141414]/50">
        <h1 className="text-sm font-semibold flex items-center gap-2">
          <Bot size={16} className="text-[#0052FF]"/> AGENT STREAM
        </h1>
      </header>

      <div className="flex-1 p-4 overflow-y-auto space-y-4" ref={streamRef}>
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col gap-1 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`${m.role === 'user' ? 'bg-[#262626]' : 'bg-[#141414] border border-[#262626]'} px-3 py-2 rounded-lg text-sm max-w-[95%] whitespace-pre-wrap`}>
              {m.content}
            </div>
          </div>
        ))}
        {sendMessageMutation.isPending && (
          <div className="flex flex-col gap-1 items-start">
             <div className="bg-[#141414] border border-[#262626] px-3 py-2 rounded-lg text-sm max-w-[95%] flex items-center gap-2 text-[#A3A3A3]">
               <Activity size={14} className="animate-pulse" /> Agent is thinking...
             </div>
          </div>
        )}
      </div>

      <div className="p-4 border-t border-[#262626] bg-[#141414]">
        <div className="relative">
          <input
            type="text"
            placeholder="Type your instructions here..."
            className="w-full bg-[#0A0A0A] border border-[#262626] rounded-md py-2.5 pl-3 pr-10 text-sm focus:outline-none focus:border-[#0052FF] focus:ring-1 focus:ring-[#0052FF] transition-all"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            disabled={sendMessageMutation.isPending}
          />
          <button
            onClick={handleSend}
            disabled={sendMessageMutation.isPending}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-[#262626] hover:bg-[#333] rounded text-[#A3A3A3] transition-colors"
          >
            <Terminal size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function App() {
  return (
    <div className="h-screen w-full flex flex-col bg-[#0A0A0A] text-[#EDEDED] overflow-hidden">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <LeftRail />
        <ActionInbox />
        <AgentStream />
      </div>
    </div>
  );
}

export default App;
