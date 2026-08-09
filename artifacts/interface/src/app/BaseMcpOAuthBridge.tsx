import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../lib/state';
import { baseMcpOAuthResultMessage } from '../lib/format';
import {
  BASE_MCP_OAUTH_MESSAGE_V1,
  BASE_MCP_OAUTH_STORAGE_KEY_V1,
} from './baseMcpPopupHandoff';

type OAuthPopupMessage = {
  type: 'miorail:base-mcp-oauth';
  result: string | null;
  code: string | null;
  wallet: string | null;
};

export function BaseMcpOAuthBridge() {
  const queryClient = useQueryClient();
  const showToast = useUiStore((state) => state.showToast);

  useEffect(() => {
    // The popup no longer reaches here: `App` renders the handoff instead of
    // the console, decided from the URL before this component exists.
    const apply = (message: OAuthPopupMessage) => {
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      const notice = baseMcpOAuthResultMessage(message.result, message.code, message.wallet);
      if (notice) showToast(notice.text);
    };

    const receive = (event: MessageEvent<OAuthPopupMessage>) => {
      if (event.origin !== window.location.origin || event.data?.type !== BASE_MCP_OAUTH_MESSAGE_V1) return;
      apply(event.data);
    };

    // The second channel. `postMessage` needs `window.opener`, and a
    // cross-origin authorization hop can arrive with it null — which is how a
    // popup ended up showing "connected" while the window that opened it still
    // said "connect again". A `storage` event needs no opener.
    const stored = (event: StorageEvent) => {
      if (event.key !== BASE_MCP_OAUTH_STORAGE_KEY_V1 || !event.newValue) return;
      try {
        const message = JSON.parse(event.newValue) as OAuthPopupMessage;
        if (message?.type !== BASE_MCP_OAUTH_MESSAGE_V1) return;
        apply(message);
      } catch {
        // A key somebody else wrote. Ignored rather than trusted.
      }
      // Cleared so a later reload does not replay a result as if it were new.
      try {
        window.localStorage?.removeItem(BASE_MCP_OAUTH_STORAGE_KEY_V1);
      } catch {
        /* blocked storage costs the cleanup and nothing else */
      }
    };

    const blocked = () => showToast('Base MCP authorization popup was blocked. Allow popups for Miorail and retry.');
    window.addEventListener('message', receive);
    window.addEventListener('storage', stored);
    window.addEventListener('miorail:base-mcp-popup-blocked', blocked);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('storage', stored);
      window.removeEventListener('miorail:base-mcp-popup-blocked', blocked);
    };
  }, [queryClient, showToast]);

  return null;
}
