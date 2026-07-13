import { useStatus } from '@mioagent/api-client-react';
import { baseMcpStatusLabel } from '../lib/format';
import { BaseMcpConnectButton } from '../components/BaseMcpConnectButton';

// T48a.1: compact, always-informational Base MCP status indicator in the
// shell, next to AuthStatus. Base MCP is optional (T48a) — this never blocks
// wallet connect or gates any route, it only surfaces connected/reconnect
// state and reuses the existing OAuth popup button
// (`BaseMcpConnectButton` → `/api/mcp/base/connect`) rather than a new
// connect mechanism.
export function BaseMcpStatusIndicator() {
  const { data: statusData } = useStatus();
  const { label, tone } = baseMcpStatusLabel(statusData?.baseMcp);
  const returnTo = typeof window === 'undefined' ? '/' : window.location.pathname || '/';

  if (tone === 'connected') {
    return (
      <span
        className="hidden sm:inline-flex items-center gap-1.5 bg-ok-soft text-ok border border-ok/20 px-2.5 py-1 rounded-full text-[11px] font-medium"
        title="Base MCP is connected"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-ok" />
        {label}
      </span>
    );
  }

  return (
    <BaseMcpConnectButton
      returnTo={returnTo}
      className="hidden sm:inline-flex items-center gap-1.5 bg-panel-2 text-ink-2 border border-line px-2.5 py-1 rounded-full text-[11px] font-medium hover:bg-line/50 transition-colors"
      title="Base MCP is optional — connect to enable portfolio, send and swap via Base"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${tone === 'action' ? 'bg-warn' : 'bg-ink-3'}`} />
      {label}
    </BaseMcpConnectButton>
  );
}
