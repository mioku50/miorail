// ---------------------------------------------------------------------------
// Handing an OAuth result back from the popup, and never becoming a second app.
//
// Two failures, both seen in production on 2026-08-09:
//
//   * The popup rendered the WHOLE console. The bridge's close() ran inside a
//     React effect, so the router, the queries and the Extensions page all
//     mounted first — and if the close never happened, the user was left
//     looking at a second, narrower copy of Miorail.
//
//   * The opener never learned. `postMessage` needs `window.opener`, and a
//     cross-origin authorization hop can arrive with it null. When that
//     happened the popup showed "connected" while the window that opened it
//     still said "connect again" — the exact screenshot that started this.
//
// So the handoff is: detect popup mode from the URL BEFORE the app renders,
// signal through two independent channels, and close. `localStorage` is the
// second channel because it fires a `storage` event in every other tab of the
// same origin and needs no opener at all.
// ---------------------------------------------------------------------------

export const BASE_MCP_OAUTH_MESSAGE_V1 = 'miorail:base-mcp-oauth' as const;

/** The key the opener-less fallback writes. Read and cleared by the bridge. */
export const BASE_MCP_OAUTH_STORAGE_KEY_V1 = 'miorail.base-mcp-oauth.v1';

export interface BaseMcpOAuthMessageV1 {
  type: typeof BASE_MCP_OAUTH_MESSAGE_V1;
  result: string | null;
  code: string | null;
  wallet: string | null;
  /** Distinguishes two results that carry identical fields, so a second
   * attempt still fires a `storage` event the browser would otherwise
   * suppress as "same value". */
  at: number;
}

/**
 * The message this window is carrying, or null when it is not a popup.
 *
 * Read from the URL, so it is available before anything mounts.
 */
export function baseMcpPopupMessageV1(search: string): BaseMcpOAuthMessageV1 | null {
  const params = new URLSearchParams(search);
  if (params.get('mcpPopup') !== '1') return null;
  return {
    type: BASE_MCP_OAUTH_MESSAGE_V1,
    result: params.get('mcp'),
    code: params.get('code'),
    wallet: params.get('mcpWallet'),
    at: Date.now(),
  };
}

/**
 * Signal every way available, then close.
 *
 * Both channels always fire. Trying `postMessage` and only falling back on
 * failure does not work: it throws nothing when the opener is null, it simply
 * does nothing, and the popup would close believing it had delivered.
 */
export function deliverBaseMcpPopupResultV1(
  message: BaseMcpOAuthMessageV1,
  win: Window = window,
): void {
  try {
    if (win.opener && win.opener !== win) {
      win.opener.postMessage(message, win.location.origin);
    }
  } catch {
    // A cross-origin opener rejects the post. The storage channel below is
    // the one that has to work anyway.
  }
  try {
    win.localStorage?.setItem(BASE_MCP_OAUTH_STORAGE_KEY_V1, JSON.stringify(message));
  } catch {
    // Storage can be blocked. Nothing further to try; the user closing the
    // popup and reloading still picks up the session from the server.
  }
  try {
    win.close();
  } catch {
    // A window the script did not open cannot close itself. The caller
    // renders a "you can close this" panel for exactly that case.
  }
}
