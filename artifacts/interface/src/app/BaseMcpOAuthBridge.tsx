import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../lib/state';
import { baseMcpOAuthResultMessage } from '../lib/format';

type OAuthPopupMessage = {
  type: 'miorail:base-mcp-oauth';
  result: string | null;
  code: string | null;
  wallet: string | null;
};

function currentPopupMessage(): OAuthPopupMessage | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('mcpPopup') !== '1') return null;
  return {
    type: 'miorail:base-mcp-oauth',
    result: params.get('mcp'),
    code: params.get('code'),
    wallet: params.get('mcpWallet'),
  };
}

export function BaseMcpOAuthBridge() {
  const queryClient = useQueryClient();
  const showToast = useUiStore((state) => state.showToast);

  useEffect(() => {
    const popupMessage = currentPopupMessage();
    if (popupMessage && window.opener && window.opener !== window) {
      window.opener.postMessage(popupMessage, window.location.origin);
      window.close();
      return;
    }

    const receive = (event: MessageEvent<OAuthPopupMessage>) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'miorail:base-mcp-oauth') return;
      void queryClient.invalidateQueries({ queryKey: ['status'] });
      const notice = baseMcpOAuthResultMessage(event.data.result, event.data.code, event.data.wallet);
      if (notice) showToast(notice.text);
    };
    const blocked = () => showToast('Base MCP authorization popup was blocked. Allow popups for Miorail and retry.');
    window.addEventListener('message', receive);
    window.addEventListener('miorail:base-mcp-popup-blocked', blocked);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('miorail:base-mcp-popup-blocked', blocked);
    };
  }, [queryClient, showToast]);

  return null;
}
