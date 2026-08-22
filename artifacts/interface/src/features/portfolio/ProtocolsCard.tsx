import { isMainnetReadonly } from '../../lib/chain';
import { capabilityLabel, capabilityState, type CapabilityState } from '../../lib/capabilityStatus';

interface ProtocolsCardProps {
  statusData: any;
  protocolsData: any;
  isProtocolsError: boolean;
  address?: string;
  toggleProtocol: (args: { protocolId: string; enabled: boolean }) => void;
}

export function ProtocolsCard({ statusData, protocolsData, isProtocolsError, address, toggleProtocol }: ProtocolsCardProps) {
  const CapabilityRow = ({ label, state }: { label: string; state: CapabilityState }) => (
    <div className="flex items-center justify-between border-b border-line py-1 text-[12px] last:border-b-0">
      <span className="text-ink-2">{label}</span>
      <span className={`font-semibold ${state === 'active' ? 'text-ok' : state === 'limited' ? 'text-warn' : 'text-ink-3'}`}>
        {capabilityLabel(state)}
      </span>
    </div>
  );

  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">Capabilities</div>
      {isMainnetReadonly ? (
        <div className="flex flex-col gap-2">
          <CapabilityRow label="Base network" state={capabilityState(statusData?.rpc?.status || (address ? 'connected' : 'missing'))} />
          <CapabilityRow label="Balances" state={capabilityState(statusData?.tokenBalances?.status)} />
          <CapabilityRow label="Contract checks" state={capabilityState(statusData?.risk?.status)} />
          <CapabilityRow label="Market prices" state={capabilityState(statusData?.prices?.status)} />
          <CapabilityRow label="Wallet tools" state={capabilityState(statusData?.baseMcp?.status)} />
        </div>
      ) : isProtocolsError || !protocolsData ? (
        <div className="text-[13px] text-risk bg-risk-soft p-3 rounded-md font-medium border border-risk/20 mt-2">Capabilities unavailable</div>
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
  );
}
