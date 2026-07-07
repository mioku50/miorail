import { isMainnetReadonly } from '../../lib/chain';
import { baseMcpHint, formatBaseMcpStatus, formatRiskProvider } from '../../lib/format';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface ProtocolsCardProps {
  statusData: any;
  protocolsData: any;
  isProtocolsError: boolean;
  address?: string;
  toggleProtocol: (args: { protocolId: string; enabled: boolean }) => void;
}

export function ProtocolsCard({ statusData, protocolsData, isProtocolsError, address, toggleProtocol }: ProtocolsCardProps) {
  return (
    <div className="bg-panel border border-line rounded-xl shadow-sm p-[18px]">
      <div className="text-[11px] font-bold tracking-[.08em] uppercase text-ink-3 mb-3">Protocols</div>
      {isMainnetReadonly ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
            <span className="text-ink-2">Base RPC</span>
            {statusData ? (
              <span className={statusData.rpc.status === 'connected' ? 'text-ok font-medium' : statusData.rpc.status === 'failed' ? 'text-risk font-medium' : 'text-warn font-medium'}>
                {statusData.rpc.status === 'connected' ? 'Connected' : statusData.rpc.status === 'failed' ? 'Failed' : 'Missing'}
              </span>
            ) : address ? (
              <span className="text-ok font-medium">Connected</span>
            ) : (
              <span className="text-warn font-medium">Missing</span>
            )}
          </div>
          <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
            <span className="text-ink-2">Token balances</span>
            {statusData ? (
               <span className={statusData.tokenBalances.status === 'connected' ? 'text-ok font-medium' : statusData.tokenBalances.status === 'failed' ? 'text-risk font-medium' : statusData.tokenBalances.status === 'disabled' ? 'text-ink-3 font-medium' : 'text-warn font-medium'}>
                 {statusData.tokenBalances.status === 'connected'
                   ? (statusData.tokenBalances.provider === 'moralis' ? 'Moralis connected' : statusData.tokenBalances.provider === 'alchemy' ? 'Alchemy connected' : 'Connected')
                   : statusData.tokenBalances.status === 'stale'
                     ? (statusData.tokenBalances.provider === 'moralis' ? 'Moralis cached' : 'Cached')
                     : statusData.tokenBalances.status === 'failed' ? (statusData.tokenBalances.provider === 'moralis' ? 'Moralis failed' : 'Failed')
                     : statusData.tokenBalances.status === 'disabled' ? 'Disabled by config' : 'Missing'}
               </span>
             ) : (
               <span className="text-warn font-medium">Missing</span>
             )}
          </div>
          <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
             <span className="text-ink-2">Risk provider</span>
             {statusData ? (
               <span className={statusData.risk.status === 'connected' ? 'text-ok font-medium' : statusData.risk.status === 'failed' ? 'text-risk font-medium' : statusData.risk.status === 'disabled' ? 'text-ink-3 font-medium' : 'text-warn font-medium'}>
                 {formatRiskProvider(statusData, 'Missing')}
               </span>
             ) : (
               <span className="text-warn font-medium">Missing</span>
             )}
           </div>
           <div className="flex items-center justify-between py-1 border-b border-line text-[12px]">
             <span className="text-ink-2">Price Provider</span>
             {statusData ? (
               <span className={statusData.prices.status === 'connected' ? 'text-ok font-medium' : statusData.prices.status === 'failed' ? 'text-risk font-medium' : statusData.prices.status === 'disabled' ? 'text-ink-3 font-medium' : 'text-warn font-medium'}>
                 {statusData.prices.status === 'connected' ? `Connected (${statusData.prices.provider})` : statusData.prices.status === 'failed' ? 'Price provider failed' : statusData.prices.status === 'disabled' ? 'Disabled by config' : 'Missing'}
               </span>
             ) : (
               <span className="text-warn font-medium">Missing</span>
             )}
           </div>
          <div className="flex items-center justify-between py-1 text-[12px]">
            <span className="text-ink-2">Base MCP</span>
            {statusData ? (
              <span className={statusData.baseMcp.status === 'connected' ? 'text-ok font-medium' : statusData.baseMcp.status === 'disabled' ? 'text-ink-3 font-medium' : statusData.baseMcp.status === 'unreachable' || statusData.baseMcp.status === 'unsupported' ? 'text-risk font-medium' : 'text-warn font-medium'}>
                {formatBaseMcpStatus(statusData.baseMcp)}
              </span>
            ) : import.meta.env.VITE_MCP_SERVER_URL ? (
              <span className="text-ok font-medium">Configured</span>
            ) : (
              <span className="text-risk font-medium">Missing</span>
            )}
          </div>
          {baseMcpHint(statusData?.baseMcp) && (
            <div className="text-[11px] text-ink-3 bg-panel-2 border border-line rounded-md px-2 py-1.5">
              {baseMcpHint(statusData?.baseMcp)}
            </div>
          )}
        </div>
      ) : isProtocolsError || !protocolsData ? (
        <div className="text-[13px] text-risk bg-risk-soft p-3 rounded-md font-medium border border-risk/20 mt-2">Provider disconnected</div>
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
