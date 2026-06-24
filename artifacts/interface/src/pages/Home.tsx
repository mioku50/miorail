import { useState } from 'react';
import { Link } from 'wouter';

export function Home() {
  const [step, setStep] = useState(1);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h2 className="text-3xl font-bold mb-6 text-slate-800">Welcome to MioAgent Demo</h2>
      <p className="text-lg text-slate-600 mb-8">
        This guided interactive demo will show you the core features of MioAgent, your autonomous development worker.
      </p>

      <div className="bg-white rounded-xl shadow-sm border p-6 mb-8">
        <div className="flex items-center gap-4 mb-6 border-b pb-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg
                  ${step === i ? 'bg-blue-600 text-white' :
                    step > i ? 'bg-green-500 text-white' : 'bg-slate-100 text-slate-400'}`}
              >
                {step > i ? '✓' : i}
              </div>
              {i < 4 && (
                <div className={`w-16 h-1 mx-2 rounded ${step > i ? 'bg-green-500' : 'bg-slate-100'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="min-h-[200px]">
          {step === 1 && (
            <div className="space-y-4 animate-in fade-in">
              <h3 className="text-xl font-semibold text-slate-800">Step 1: Configure Settings</h3>
              <p className="text-slate-600">
                Start by configuring your LLM provider, preferred models, and protocol toggles in the Settings page.
                This gives the agent the context and permissions it needs to operate.
              </p>
              <div className="pt-4">
                <Link href="/settings">
                  <a className="inline-block px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors font-medium">
                    Go to Settings
                  </a>
                </Link>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 animate-in fade-in">
              <h3 className="text-xl font-semibold text-slate-800">Step 2: Interact in Chat</h3>
              <p className="text-slate-600">
                Talk to the agent directly. You can ask for portfolio analysis, token research, or instruct it to prepare a transaction.
                The agent will generate executable actions based on your conversation.
              </p>
              <div className="pt-4">
                <Link href="/chat">
                  <a className="inline-block px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors font-medium">
                    Go to Chat
                  </a>
                </Link>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 animate-in fade-in">
              <h3 className="text-xl font-semibold text-slate-800">Step 3: Review Actions</h3>
              <p className="text-slate-600">
                MioAgent is designed with a strict no-custody policy. Actions proposed by the agent (like trades or configuration changes)
                land in the Actions inbox. You must review and explicitly approve them before execution.
              </p>
              <div className="pt-4">
                <Link href="/actions">
                  <a className="inline-block px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors font-medium">
                    Go to Actions Inbox
                  </a>
                </Link>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4 animate-in fade-in">
              <h3 className="text-xl font-semibold text-slate-800">Step 4: Automate with Workflows</h3>
              <p className="text-slate-600">
                Set up background jobs, like periodic portfolio scanners or token price monitors. Workflows run autonomously
                based on your instructions and interval, pushing new findings directly to your Actions inbox.
              </p>
              <div className="pt-4">
                <Link href="/workflows">
                  <a className="inline-block px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors font-medium">
                    Go to Workflows
                  </a>
                </Link>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 flex justify-between items-center pt-4 border-t">
          <button
            onClick={() => setStep(Math.max(1, step - 1))}
            disabled={step === 1}
            className="px-6 py-2 rounded-lg font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          >
            Previous
          </button>

          <button
            onClick={() => setStep(Math.min(4, step + 1))}
            disabled={step === 4}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {step === 4 ? 'Finish' : 'Next Step'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="bg-blue-50 p-6 rounded-xl border border-blue-100">
           <h4 className="text-lg font-bold text-blue-900 mb-2">No-Custody by Design</h4>
           <p className="text-blue-800 text-sm">
             All executions are simulated. You maintain full control over your keys.
             Approvals generate EIP-5792 compatible links.
           </p>
        </div>
        <div className="bg-indigo-50 p-6 rounded-xl border border-indigo-100">
           <h4 className="text-lg font-bold text-indigo-900 mb-2">Base Sepolia Ready</h4>
           <p className="text-indigo-800 text-sm">
             The agent connects to Base Sepolia via MCP to fetch real on-chain data and simulate state changes securely.
           </p>
        </div>
      </div>
    </div>
  );
}
