// ---------------------------------------------------------------------------
// What a log line may not carry (audit OPS-2, 2026-11-14).
//
// The API's earn preflight printed viem's error message at startup, and that
// message names the request: "URL: https://base-mainnet.infura.io/v3/<project
// key>". Three such lines sat in the API's journal for weeks, and any excerpt
// of it pasted into a chat, a ticket or an agent's session carried a key that
// spends the Infura quota. viem's message also quotes the request body, where a
// wallet address is the first parameter.
//
// So every line the logger writes is redacted first, and an error is told by
// its name, status and code with a redacted short message, never its raw text.
// A URL keeps its host and the shape of its path; a key in its path (Infura's
// /v3/<key>, Alchemy's /v2/<key>, a QuickNode token), a key-like query
// parameter, credentials before the host and a Bearer token do not survive. An
// error's words also lose any 40-hex address or 64-hex hash they quote.
// ---------------------------------------------------------------------------

const URL_V1 = /\bhttps?:\/\/[^\s"'<>`\\]+/gi;
const SECRET_PARAM_V1 = /^(?:api[-_]?key|apikey|key|keys|token|access[-_]?token|auth|authorization|secret|client[-_]?secret|password|passwd|signature|sig)$/i;
const BEARER_V1 = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/** A path segment or query value that looks like a credential: long, and made of letters and digits both. */
function keyLikeV1(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9_-]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function decodeSafeV1(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

function redactUrlV1(raw: string): string {
  // Punctuation that ends a sentence is not part of the URL.
  const trail = /[).,;:!?\]}]+$/.exec(raw)?.[0] ?? '';
  const text = trail ? raw.slice(0, -trail.length) : raw;
  let url: URL;
  try { url = new URL(text); } catch { return `(url)${trail}`; }
  // A Telegram bot token is a path segment too: /bot<id>:<secret>/sendMessage.
  const path = url.pathname.split('/').map((segment) => keyLikeV1(segment) || /^bot\d+:[A-Za-z0-9_-]{16,}$/.test(decodeSafeV1(segment)) ? '…' : segment).join('/');
  const query = url.search.length > 1
    ? `?${url.search.slice(1).split('&').map((pair) => {
      const at = pair.indexOf('='), name = at < 0 ? pair : pair.slice(0, at), value = at < 0 ? '' : pair.slice(at + 1);
      return at >= 0 && (SECRET_PARAM_V1.test(decodeSafeV1(name)) || keyLikeV1(value)) ? `${name}=…` : pair;
    }).join('&')}`
    : '';
  // `host` leaves out anything written before an @, and the fragment is not kept.
  return `${url.protocol}//${url.host}${path}${query}${trail}`;
}

/** The text with credentials removed from every URL in it, and any Bearer token. */
export function redactSecretsV1(text: string): string {
  return text.replace(URL_V1, (raw) => redactUrlV1(raw)).replace(BEARER_V1, 'Bearer …');
}

/** An error's own words, with secrets, addresses and hashes removed: for a line that names why something failed. */
export function redactErrorTextV1(text: string): string {
  return redactSecretsV1(text).replace(/\b0x[0-9a-fA-F]{64}\b/g, '0x…').replace(/\b0x[0-9a-fA-F]{40}\b/g, '0x…');
}

/** What may be logged of an error: its name, its HTTP status or code when it has one, and a short redacted detail. */
export function errorFactsV1(error: unknown): { errorName: string; status?: number; code?: string | number; detail: string } {
  if (!(error instanceof Error)) {
    return { errorName: typeof error, detail: typeof error === 'string' ? redactErrorTextV1(error).slice(0, 160) : '' };
  }
  const e = error as Error & { shortMessage?: unknown; status?: unknown; code?: unknown };
  // viem's shortMessage is the first sentence, before the URL and the request body it goes on to quote.
  const words = typeof e.shortMessage === 'string' ? e.shortMessage : (e.message.split('\n')[0] ?? '');
  return {
    errorName: e.name || 'Error',
    ...(typeof e.status === 'number' && Number.isFinite(e.status) ? { status: e.status } : {}),
    ...((typeof e.code === 'string' && e.code.length <= 64) || (typeof e.code === 'number' && Number.isFinite(e.code)) ? { code: e.code } : {}),
    detail: redactErrorTextV1(words).slice(0, 160),
  };
}

/** One line for a console that names an error: "HttpRequestError status 429: HTTP request failed." */
export function describeErrorV1(error: unknown): string {
  const facts = errorFactsV1(error);
  return `${facts.errorName}${facts.status !== undefined ? ` status ${facts.status}` : ''}${facts.code !== undefined ? ` code ${facts.code}` : ''}${facts.detail ? `: ${facts.detail}` : ''}`;
}
