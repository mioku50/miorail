import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { STILL_PUBLIC_HOST_V1 } from '../../lib/stillOrigin.js';

// ---------------------------------------------------------------------------
// Still's review card in an assistant's chat (MCP Apps, io.modelcontextprotocol/ui).
//
// A host that draws apps renders ui://still/review.html beside the result of a
// miorail_prepare_still_* or status tool: what was prepared, one button to
// review and sign it on Still's site, and where it stands, read through the
// host with the person's own connection; or, where the server has a
// WalletConnect project id, the same review signed from the person's phone
// wallet inside the chat (stillCardLending.ts). The card holds no key: the
// wallet signs. The file is the interface build's dist/mcp-app/index.html,
// deployed to the web root beside index.html.
//
// Every client's Still tools name the card, and any client can read it: a host
// that draws nothing ignores _meta. The card used to be named only to a client
// that said, when it connected, that it draws apps, remembered per grant. But
// one grant can serve two hosts: on 2026-11-05 the operator's Claude grant was
// listed last by a client that draws nothing, and claude.ai then showed a loan
// as a plain tool call. Only the card's own tool (stillCardLending.ts), which
// hands a ready review's calls to the card, is still for a client that draws
// apps (index.ts remembers that per grant).
//
// A host keeps a card by its address. On 2026-11-04 Claude drew the card it
// had fetched before a deploy, one that knew nothing of a purchase paid from
// the wallet, and said it could not read the result: it listed the resources
// again and never read the card. So the address names the card's content
// (ui://still/review.<hash>.html), and a new card is a new address.
//
// A host also keeps the tools it listed, with the address they named. The
// same day Claude, holding the list from before that deploy, read the card by
// its old address from the restarted server, which no longer had that address
// and had forgotten that this grant draws apps: it said "Unable to reach". So
// every address the card has had answers with the card deployed now, and a
// host that reads the card is known again to draw it (index.ts).
// ---------------------------------------------------------------------------

export const MCP_APPS_EXTENSION_V1 = 'io.modelcontextprotocol/ui';
export const STILL_CARD_URI_V1 = 'ui://still/review.html';
/** Every address the card has had: the plain one, and one named by its content. */
export const STILL_CARD_ADDRESS_V1 = /^ui:\/\/still\/review(?:\.[0-9a-f]{12})?\.html$/;
export const STILL_CARD_MIME_V1 = 'text/html;profile=mcp-app';
/** On a tool: the spec's key, and the flat one older hosts read. */
export function stillCardToolMetaV1(uri: string) {
  return { ui: { resourceUri: uri }, 'ui/resourceUri': uri };
}
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

let cardV1: { html: string; uri: string } | null = null;
/** The deployed file as it is served, and the address that names it; read once, since it changes only
 * with a deploy, which restarts this process. A missing file is read again next time, not remembered. */
function deployedCardV1(): { html: string; uri: string } | null {
  if (cardV1) return cardV1;
  const webIndex = (process.env.MIORAIL_WEB_INDEX_HTML ?? '').trim() || '/var/www/miorail/index.html';
  // Public by design (a dapp's id), and still the operator's: an id that is not one leaves the card without WalletConnect.
  const projectId = (process.env.STILL_WALLETCONNECT_PROJECT_ID ?? '').trim();
  let html: string;
  try { html = readFileSync(path.join(path.dirname(webIndex), 'mcp-app', 'index.html'), 'utf8'); } catch { return null; }
  html = html.replaceAll(PROJECT_ID_SLOT_V1, /^[0-9a-f]{32}$/.test(projectId) ? projectId : '');
  cardV1 = { html, uri: `ui://still/review.${createHash('sha256').update(html).digest('hex').slice(0, 12)}.html` };
  return cardV1;
}
/** Testing seam: forget the file read once. */
export function resetStillCardHtmlV1(): void { cardV1 = null; }
export const stillCardRuntimeV1 = {
  html: async (): Promise<string> => {
    const card = deployedCardV1();
    if (!card) throw new Error('still_card_missing');
    return card.html;
  },
  /** Where the card is: its content's own address, or the plain one where no card is deployed. */
  uri: (): string => deployedCardV1()?.uri ?? STILL_CARD_URI_V1,
};

export function registerStillCardV1(server: McpServer, uri: string): void {
  const about = {
    title: 'Still review card',
    description: `What an assistant prepared through Still, a button to review and sign it on ${STILL_PUBLIC_HOST_V1}, and where it stands.`,
    mimeType: STILL_CARD_MIME_V1,
  };
  const read = async (address: URL) => ({
    contents: [{ uri: address.href, mimeType: STILL_CARD_MIME_V1, text: await stillCardRuntimeV1.html(),
      _meta: { ui: { csp: STILL_CARD_CSP_V1, prefersBorder: false } } }],
  });
  server.registerResource('still-review-card', uri, about, read);
  // Any address a host kept from before a deploy, through one template: the card deployed now.
  server.registerResource('still-review-card-earlier', new ResourceTemplate('ui://still/review{rest}', { list: undefined }), about, async (address) => {
    if (!STILL_CARD_ADDRESS_V1.test(address.href)) throw new McpError(ErrorCode.InvalidParams, `Resource ${address.href} not found`);
    return read(address);
  });
}
