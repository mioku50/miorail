import { useEffect, useState } from 'react';
import { useConnectTelegram, useDisconnectTelegram, useTelegramLink } from '@mioagent/api-client-react';

import type { TelegramAlertsModelV1 } from './TelegramAlertsStrip';
import { telegramAlertsViewV1 } from './telegramAlertsView';

/**
 * Alerts in Telegram: signed in only, and only where a bot exists. A link that
 * was issued is polled for until the reader presses Start or it lapses. One
 * hook for every place that offers it, the Stocks board and Still's Home, so
 * the two cannot disagree about whether this wallet is connected.
 */
export function useTelegramAlertsV1(input: { enabled: boolean }): TelegramAlertsModelV1 | null {
  const [pending, setPending] = useState<{ url: string; expiresAt: string } | null>(null);
  const [failed, setFailed] = useState<'connect' | 'disconnect' | null>(null);
  const link = useTelegramLink({ enabled: input.enabled, poll: pending !== null });
  const connect = useConnectTelegram();
  const disconnect = useDisconnectTelegram();
  useEffect(() => {
    if (!pending) return;
    if (link.data?.linked) {
      setPending(null);
      return;
    }
    const left = Date.parse(pending.expiresAt) - Date.now();
    const timer = setTimeout(() => setPending(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [pending, link.data?.linked]);
  const view = telegramAlertsViewV1({
    status: input.enabled ? link.data : null,
    pending,
    busy: connect.isPending ? 'connect' : disconnect.isPending ? 'disconnect' : null,
    failed,
    now: new Date(),
  });
  if (!view) return null;
  return {
    view,
    onConnect: () => {
      setFailed(null);
      connect.mutate(undefined, {
        onSuccess: (issued) => setPending(issued),
        onError: () => setFailed('connect'),
      });
    },
    onDisconnect: () => {
      setFailed(null);
      disconnect.mutate(undefined, { onError: () => setFailed('disconnect') });
    },
  };
}
