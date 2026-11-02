import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Still's review card in an assistant's chat (MCP Apps, io.modelcontextprotocol/ui).
//
// A host that draws apps renders ui://still/review.html beside the result of a
// miorail_prepare_still_* or status tool: what was prepared, one button to
// review and sign it on stills.lat, and where it stands, read through the
// host with the person's own connection; or, where the server has a
// WalletConnect project id, the same review signed from the person's phone
// wallet inside the chat (stillCardLending.ts). The card holds no key: the
// wallet signs. The file is the interface build's dist/mcp-app/index.html,
// deployed to the web root beside index.html.
//
// A host that draws nothing would list the card's metadata as noise, so it is
// attached only for a client that said, when it connected, that it draws apps
// (index.ts remembers that per grant).
// ---------------------------------------------------------------------------

export const MCP_APPS_EXTENSION_V1 = 'io.modelcontextprotocol/ui';
export const STILL_CARD_URI_V1 = 'ui://still/review.html';
export const STILL_CARD_MIME_V1 = 'text/html;profile=mcp-app';
/** On a tool: the spec's key, and the flat one older hosts read. */
export const STILL_CARD_TOOL_META_V1 = { ui: { resourceUri: STILL_CARD_URI_V1 }, 'ui/resourceUri': STILL_CARD_URI_V1 };
/** Its fonts, and WalletConnect: the relay that pairs the person's wallet,
 * its RPC for receipts, its Verify frame and its event counter. Every read of
 * Still's own goes through the host. */
const STILL_CARD_CSP_V1 = {
  connectDomains: ['wss://relay.walletconnect.org', 'wss://relay.walletconnect.com', 'https://rpc.walletconnect.org', 'https://rpc.walletconnect.com',
    'https://verify.walletconnect.org', 'https://verify.walletconnect.com', 'https://pulse.walletconnect.org'],
  resourceDomains: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  frameDomains: ['https://verify.walletconnect.org', 'https://verify.walletconnect.com'],
};
/** Stands in the built file for the WalletConnect project id, which lives in the server's env, not the repository. */
const PROJECT_ID_SLOT_V1 = '__STILL_WALLETCONNECT_PROJECT_ID__';

/** Whether an initialize request's capabilities say the client draws ui:// apps. */
export function drawsStillCardV1(capabilities: unknown): boolean {
  const ui = (capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | null | undefined)?.extensions?.[MCP_APPS_EXTENSION_V1];
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(STILL_CARD_MIME_V1);
}

let cardHtmlV1: Promise<string> | null = null;
/** Testing seam: forget the file read once. */
export function resetStillCardHtmlV1(): void { cardHtmlV1 = null; }
export const stillCardRuntimeV1 = {
  /** The deployed file, read once: it changes only with a deploy, which restarts this process. */
  html: (): Promise<string> => {
    if (!cardHtmlV1) {
      const webIndex = (process.env.MIORAIL_WEB_INDEX_HTML ?? '').trim() || '/var/www/miorail/index.html';
      // Public by design (a dapp's id), and still the operator's: an id that is not one leaves the card without WalletConnect.
      const projectId = (process.env.STILL_WALLETCONNECT_PROJECT_ID ?? '').trim();
      const reading = readFile(path.join(path.dirname(webIndex), 'mcp-app', 'index.html'), 'utf8')
        .then((html) => html.replaceAll(PROJECT_ID_SLOT_V1, /^[0-9a-f]{32}$/.test(projectId) ? projectId : ''));
      cardHtmlV1 = reading;
      // A missing file is read again next time, not remembered as missing.
      reading.catch(() => { if (cardHtmlV1 === reading) cardHtmlV1 = null; });
    }
    return cardHtmlV1;
  },
};

export function registerStillCardV1(server: McpServer): void {
  server.registerResource('still-review-card', STILL_CARD_URI_V1, {
    title: 'Still review card',
    description: 'What an assistant prepared through Still, a button to review and sign it on stills.lat, and where it stands.',
    mimeType: STILL_CARD_MIME_V1,
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: STILL_CARD_MIME_V1, text: await stillCardRuntimeV1.html(),
      _meta: { ui: { csp: STILL_CARD_CSP_V1, prefersBorder: false } } }],
  }));
}
