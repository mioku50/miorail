import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useCreateRecommendation } from '@mioagent/api-client-react';
import { useUiStore } from '../../lib/state';
import { isMainnetReadonly } from '../../lib/chain';

const PRESETS = [
  'Create a read-only swap plan for 0.1 ETH to USDC',
  'Scan Token Approvals',
  'Create a read-only portfolio rebalance report',
];

export function ActionsBuilder() {
  const { address } = useAccount();
  const [instruction, setInstruction] = useState('');
  const createAction = useCreateRecommendation();
  const showToast = useUiStore((s) => s.showToast);

  const handleCreate = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    createAction.mutate({ instruction: trimmed, walletAddress: address, chainEnv: import.meta.env.VITE_CHAIN_ENV }, {
      onSuccess: () => {
        const toastMsg = isMainnetReadonly ? 'Read-only recommendation created in Action Inbox' : 'Testnet recommendation created in Action Inbox';
        showToast(toastMsg);
        setInstruction('');
      },
      onError: (e) => showToast('Failed to create: ' + e.message),
    });
  };

  return (
    <main className="flex-1 bg-bg p-5 flex flex-col gap-4 overflow-y-auto pb-16 md:pb-5">
      <h1 className="text-[20px] font-display font-bold text-ink tracking-[-0.02em]">Actions Builder</h1>
      <div className="bg-panel border border-line rounded-xl p-5 flex flex-col gap-4 shadow-sm">
        <div>
          <label className="text-sm font-bold text-ink flex justify-between items-center">
            <span>Instruction</span>
            <span className="text-xs font-normal text-ink-3">Natural language operation</span>
          </label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. Review my Base token list and flag risky assets"
            className="w-full mt-2 border border-line rounded-lg p-3 text-sm bg-bg resize-none h-[100px] text-ink focus:outline-none focus:border-accent font-mono"
          />
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-ink-3 tracking-wider mb-2">Quick Presets</div>
          <div className="flex flex-col gap-1.5">
            {PRESETS.map((preset, idx) => (
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
          <div>Security: <span className="text-ink-3 font-medium">screening not active (verdicts not stored)</span></div>
        </div>
        {isMainnetReadonly && (
          <div className="text-[11px] text-warn bg-warn-soft p-2.5 rounded-lg border border-warn/20 font-medium flex items-center gap-2">
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
                <span className="px-2 py-0.5 rounded text-[11px] font-medium border bg-ok-soft text-ok border-ok/20">
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
                <span className={`px-2 py-0.5 rounded text-[11px] font-medium border ${isMainnetReadonly ? 'bg-risk-soft text-risk border-risk/20' : 'bg-ok-soft text-ok border-ok/20'}`}>
                  Safety: {isMainnetReadonly ? 'blocked - read only mode' : 'executable'}
                </span>
              </div>
              <div className={`mt-1 font-medium px-2 py-1 rounded border text-[11px] w-fit ${isMainnetReadonly ? 'bg-warn-soft text-warn border-warn/20' : 'bg-ok-soft text-ok border-ok/20'}`}>
                {isMainnetReadonly ? 'Read-only recommendation (execution disabled on mainnet)' : 'Executable testnet recommendation'}
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
