import { useStatus } from '@mioagent/api-client-react';

// F2 stub — honest empty state using the only real datum (x402.status). F4
// (T12.4) expands this into the full fuel meter (per-action pricing, USDC
// balance, inference/tools breakdown, history) once the backend exposes them.
export function FuelMeter() {
  const { data: statusData } = useStatus();
  const x402Status = statusData?.x402?.status;
  const label = x402Status === 'configured' ? 'configured' : x402Status === 'missing' ? 'not configured' : 'simulated';

  return (
    <main className="flex-1 bg-bg p-[18px] flex flex-col gap-4 overflow-y-auto">
      <h2 className="text-[16px] font-bold text-ink">x402 Fuel Meter</h2>
      <div className="bg-panel border border-line rounded-xl p-8 flex flex-col items-center gap-3 text-center">
        <div className="w-10 h-10 rounded-full bg-panel-2 text-ink-3 flex items-center justify-center text-lg">⛽</div>
        <div className="text-base font-bold text-ink">No live spend data</div>
        <div className="text-xs text-ink-2 max-w-md leading-relaxed">
          x402 micropayments are {label}. Per-action pricing, the USDC balance, and the inference/tools spend breakdown will appear here when the backend exposes them.
        </div>
      </div>
    </main>
  );
}
