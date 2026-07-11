import { useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import { useChatHistory, useSendMessage, useClearChatHistory, useStatus, useBaseMcpToolsProbe, useAutonomy } from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';
import { useNetworkLabel } from '../../lib/useNetworkLabel';
import { ChatMessage } from './ChatMessage';
import { AgentComposer } from './AgentComposer';
import { baseMcpConnectHref, baseMcpConnectLabel, baseMcpNeedsAuth, baseMcpOAuthResultMessage } from '../../lib/format';

const PROMPT_CHIPS = [
  'Check my Base balance',
  'Review my Base tokens',
  'Check token security',
  'Create a read-only rebalance plan',
  'Check spend permissions',
  'Show available USDC Morpho vaults',
];

export function AgentStream({ fullWidth }: { fullWidth?: boolean } = {}) {
  const { address } = useAccount();
  const { data: chatData, refetch } = useChatHistory();
  const { data: statusData } = useStatus();
  const { data: autonomyState } = useAutonomy();
  const baseMcpProbe = useBaseMcpToolsProbe();
  const sendMessageMutation = useSendMessage();
  const clearChat = useClearChatHistory();
  const showToast = useUiStore((s) => s.showToast);
  const { label: networkLabel } = useNetworkLabel();
  const [input, setInput] = useState('');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const baseMcpProbeStarted = useRef(false);
  const oauthParams = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const oauthMessage = baseMcpOAuthResultMessage(oauthParams?.get('mcp'), oauthParams?.get('code'));
  const executionMode = statusData?.execution?.mode === 'user-confirmed'
    && statusData.execution.userConfirmedEnabled === true
    && autonomyState?.sessionKey?.executionReady === true
      ? 'user-confirmed' as const
      : 'read-only' as const;

  const messages = chatData?.messages || [];
  const displayMessages = messages;

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [displayMessages, isCollapsed]);

  useEffect(() => {
    if (!statusData?.baseMcp?.auth?.connected || baseMcpProbeStarted.current) return;
    if ((statusData.baseMcp.toolsCount || 0) > 0 && !statusData.baseMcp.auth.expired) return;
    baseMcpProbeStarted.current = true;
    baseMcpProbe.mutate();
  }, [baseMcpProbe, statusData?.baseMcp?.auth?.connected, statusData?.baseMcp?.auth?.expired, statusData?.baseMcp?.toolsCount]);

  const handleSendMsg = async (msgText: string) => {
    if (!msgText.trim() || sendMessageMutation.isPending) return;
    setErrorMsg(null);
    setInput('');
    try {
      await sendMessageMutation.mutateAsync({
        message: msgText,
        walletAddress: address,
        chainEnv: statusData?.chainEnv || 'mainnet-readonly',
      });
      refetch();
      setTimeout(() => document.getElementById('agent-stream-input')?.focus(), 50);
    } catch (err: any) {
      console.error(err);
      const errMsg = err.message || 'Failed to send instruction';
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
      },
    });
  };

  if (isCollapsed && !fullWidth) {
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
        <div className="w-2.5 h-2.5 rounded-full bg-ok animate-pulse" title="Agent Ready" />
      </aside>
    );
  }

  return (
    <aside className={fullWidth ? "flex-1 bg-bg flex flex-col h-full overflow-hidden z-10" : "w-[400px] shrink-0 border-l border-line bg-panel flex flex-col h-full overflow-hidden shadow-sm z-10"}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-line bg-panel flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${sendMessageMutation.isPending ? 'bg-warn animate-ping' : sendMessageMutation.isError ? 'bg-risk' : 'bg-pop animate-pulse'}`} title="Status" style={sendMessageMutation.isPending || sendMessageMutation.isError ? undefined : { boxShadow: '0 0 6px var(--color-pop)' }} />
          <div>
            <div className="text-sm font-display font-bold text-ink flex items-center gap-2">
              <span>Agent Stream</span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${sendMessageMutation.isPending ? 'bg-warn-soft text-warn' : sendMessageMutation.isError ? 'bg-risk-soft text-risk' : 'bg-ok-soft text-ok'}`}>
                {sendMessageMutation.isPending ? 'Thinking...' : sendMessageMutation.isError ? 'Error' : displayMessages.some((m: any) => m.role === 'assistant' && (m.actionId || m.metadata?.actionId)) ? 'Recommendation created' : 'Ready'}
              </span>
            </div>
            <div className="text-[11px] text-ink-3 font-medium">{networkLabel} {address ? '· Connected' : ''}</div>
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
          {!fullWidth && (
            <button
              onClick={() => setIsCollapsed(true)}
              className="p-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-bg transition-colors cursor-pointer text-xs font-bold"
              title="Collapse panel"
              aria-label="Collapse panel"
            >
              ⇥
            </button>
          )}
        </div>
      </div>

      {(oauthMessage?.kind === 'error' || baseMcpNeedsAuth(statusData?.baseMcp)) && (
        <div className="flex items-center justify-between gap-3 border-b border-warn/20 bg-warn-soft px-4 py-2 text-[11px] text-warn">
          <span>{oauthMessage?.kind === 'error' ? oauthMessage.text : 'Base MCP wallet reads need authorization or a refreshed tool inventory.'}</span>
          <a
            href={baseMcpConnectHref('/stream')}
            className="shrink-0 rounded-lg border border-warn/30 bg-panel px-2.5 py-1 font-bold text-warn hover:bg-bg"
          >
            {baseMcpConnectLabel(statusData?.baseMcp)}
          </a>
        </div>
      )}

      {/* Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-bg/40" ref={streamRef}>
        {displayMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center p-2 text-center my-auto animate-in fade-in">
            <div className="w-12 h-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center text-2xl mb-3 shadow-sm">✨</div>
            <h3 className="text-sm font-display font-bold text-ink mb-1.5">Ask Miorail anything about your Base wallet</h3>
            <p className="text-xs text-ink-2 max-w-[280px] leading-relaxed mb-6">
              Miorail can review your portfolio, flag suspicious tokens, create read-only recommendations, and explain what it would do before any execution.
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

        {displayMessages.map((m: any, i: number) => (
          <ChatMessage key={i} m={m} networkLabel={networkLabel} />
        ))}
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

      <AgentComposer
        input={input}
        setInput={setInput}
        onSend={() => handleSendMsg(input)}
        isPending={sendMessageMutation.isPending}
        errorMsg={errorMsg}
        onClearError={() => setErrorMsg(null)}
        executionMode={executionMode}
      />
    </aside>
  );
}
