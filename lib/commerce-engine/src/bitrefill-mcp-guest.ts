import { z } from 'zod';
import { partnerFetch } from '@mioagent/security/httpAllowlist';

import { BITREFILL_ORIGIN_V1 } from './pinned-config.js';
import { ToonParseError, decodeToonV1 } from './toon.js';

// ---------------------------------------------------------------------------
// Still Spend, stage 1: Bitrefill's catalogue, read as a guest of their MCP.
//
// Still never buys through the operator's Personal API key: Bitrefill writes
// that it is for personal projects and that one key must not be handed to many
// end users. A guest reads the catalogue with no account at all. Still was
// registered by a Client ID Metadata Document (stills.lat/clients/
// bitrefill-mcp.json), a client_id that is that URL and needs no secret. On
// 2026-11-02 Bitrefill stopped trusting it ("client_id metadata document URL is
// not trusted by this authorization server"), and Still registered at
// Bitrefill's own registration endpoint instead: a guest client still, with no
// account, whose id and secret the server's environment holds. The document
// remains the client when no registered one is configured. The token lives six
// hours and is held in memory only.
//
// The catalogue READS: search-products and get-product-details. The transport
// refuses any tool its caller did not list; the checkout beside it
// (bitrefill-guest-checkout.ts) is the only caller that lists buy-products and
// get-invoice-by-id. Nothing here can pay: the person's own wallet does.
// ---------------------------------------------------------------------------

export const BITREFILL_MCP_URL_V1 = `${BITREFILL_ORIGIN_V1}/mcp`;
export const BITREFILL_MCP_TOKEN_URL_V1 = `${BITREFILL_ORIGIN_V1}/oauth/mcp/token`;

/** Bitrefill's own rule for an affiliate code: 6 to 16 letters and digits. Bitrefill drops anything else
 * in silence and the purchase goes through unattributed, so a code that breaks the rule is refused here. */
export const BITREFILL_AFFILIATE_CODE_V1 = /^[A-Za-z0-9]{6,16}$/;

/** Where the MCP requests go: the server itself, with Still's affiliate code as `?ref=` when it has one.
 * Bitrefill reads the code from the URL of every request, a guest's included: "part of the URL your
 * client stores, not something you send once" (its partner integration guide, 2026-09-10). The code
 * changes whom Bitrefill pays a commission, never the buyer's price. The token request's resource stays
 * the server itself, as the guide's own token request names it. */
export function bitrefillMcpEndpointV1(affiliateCode?: string): string {
  if (affiliateCode === undefined) return BITREFILL_MCP_URL_V1;
  if (!BITREFILL_AFFILIATE_CODE_V1.test(affiliateCode)) throw new TypeError('bitrefill_affiliate_code_invalid');
  return `${BITREFILL_MCP_URL_V1}?ref=${affiliateCode}`;
}
export const STILL_BITREFILL_CLIENT_ID_V1 = 'https://stills.lat/clients/bitrefill-mcp.json';
/** The only tools this client may call. */
export const BITREFILL_GUEST_READ_TOOLS_V1 = ['search-products', 'get-product-details'] as const;

export const SPEND_PRODUCT_TYPES_V1 = ['esim', 'refill', 'giftcard'] as const;
export type SpendProductTypeV1 = (typeof SPEND_PRODUCT_TYPES_V1)[number];

export interface SpendProductSummaryV1 {
  id: string;
  name: string;
  /** ISO alpha-2 codes the product serves. */
  countries: string[];
  inStock: boolean;
}

export interface SpendPackageV1 {
  /** What is bought: "10GB, 30 Days", or a face value such as "50". */
  value: string;
  /** The currency of a face value, "EUR" for a 50 EUR card; null when Bitrefill named none. */
  faceCurrency: string | null;
  /** Its price in USDC, as Bitrefill quoted it, a decimal string. */
  priceUsdc: string;
}

export interface SpendProductV1 {
  id: string;
  name: string;
  country: string | null;
  inStock: boolean;
  /** Whether a phone number or an account is needed to buy it, as Bitrefill says. */
  recipientType: string | null;
  packages: SpendPackageV1[];
  url: string | null;
  /** Bitrefill sells it only after its prepayment steps (submit-prepayment-step:
   * a game's player ID and the like), which it does not offer Still's guest
   * client, so Still cannot buy it. Absent on a value not read from Bitrefill. */
  prepayment?: boolean;
}

export type SpendFailureV1 =
  | 'bitrefill_unreachable'
  | 'bitrefill_refused'
  /** Bitrefill would not let Still in as its guest: nothing can be read or bought until that changes. */
  | 'bitrefill_guest_refused'
  | 'bitrefill_rate_limited'
  | 'bitrefill_invalid_response'
  | 'bitrefill_product_not_found'
  /** The invoice asks a different amount than the price quoted a moment before. */
  | 'bitrefill_invoice_price_changed';

/** `local`: refused here, by Still's own share of Bitrefill's window, before anything was asked of Bitrefill. */
export type SpendResultV1<T> = { ok: true; value: T } | { ok: false; reason: SpendFailureV1; detail?: string; local?: true };

/** Bitrefill's own words for a refusal, safe to log and to show: one line, no
 * email, no link, no long number (a phone, an order or an account). */
export function spendRefusalDetailV1(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim()
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\d{6,}/g, '[number]')
    .slice(0, 160);
  return line || undefined;
}

/** What a refusing HTTP answer said: an OAuth or JSON-RPC error's own words, or its text. */
function refusalTextV1(raw: string): string {
  const data = raw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).pop() ?? raw;
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    const error = json.error as unknown;
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
    const words = [error, json.error_description, json.message].filter((word): word is string => typeof word === 'string');
    if (words.length) return words.join(': ');
  } catch {
    // Not JSON: its text, without markup.
  }
  return data.replace(/<[^>]*>/g, ' ');
}

const SLUG_V1 = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const COUNTRY_V1 = /^[A-Z]{2}$/;
const PRICE_V1 = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/;

const TokenSchemaV1 = z.object({ access_token: z.string().min(16).max(4096), expires_in: z.number().int().positive().optional() }).passthrough();
const RpcSchemaV1 = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  }).passthrough().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
}).passthrough();

const TextSchemaV1 = z.union([z.string(), z.number()]).transform(String);
const SearchSchemaV1 = z.object({
  products: z.array(z.object({
    slug: z.string(),
    name: TextSchemaV1,
    countries: z.array(TextSchemaV1).optional(),
    in_stock: z.boolean().optional(),
  }).passthrough()).max(250),
}).passthrough();
const DetailSchemaV1 = z.object({
  id: z.string(),
  name: TextSchemaV1,
  country_code: z.string().optional(),
  in_stock: z.boolean().optional(),
  recipient_type: z.string().optional(),
  prepayment: z.unknown().optional(),
  packages: z.array(z.object({
    package_value: TextSchemaV1,
    package_currency: z.string().optional(),
    payment_price: TextSchemaV1,
    payment_currency: z.string(),
  }).passthrough()).max(200).optional(),
  url: z.string().optional(),
}).passthrough();

export interface BitrefillGuestCatalogV1 {
  search(input: { type: SpendProductTypeV1; country: string; query?: string }): Promise<SpendResultV1<SpendProductSummaryV1[]>>;
  /** Only the server's checkout asks for priority; public product reads use the ordinary budget. */
  product(id: string, options?: { freshForCheckout?: true }): Promise<SpendResultV1<SpendProductV1>>;
}

export interface BitrefillGuestOptionsV1 {
  clientId?: string;
  /** A registered client's secret, sent as client_secret_post. Without one the
   * client is Still's metadata document, which Bitrefill stopped trusting on
   * 2026-11-02; Still registered by Bitrefill's own registration endpoint. */
  clientSecret?: string;
  /** Still's affiliate code at Bitrefill, sent as `?ref=` on every MCP request (bitrefillMcpEndpointV1).
   * One that breaks Bitrefill's rule throws here rather than going out to be dropped. */
  affiliateCode?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Calls a minute, under Bitrefill's thirty per token. */
  perMinute?: number;
  /** The ordinary part of that same window; the remainder is reserved for priority calls.
   * OAuth and every retry count too. This never increases perMinute. */
  normalPerMinute?: number;
  /** The ordinary and priority parts together; what is left of perMinute only reserved calls may use:
   * opening an invoice and the read before a loan's next step (audit SPEND-2, 2026-11-14: reviews read
   * by a few free wallets kept the window full, and a buyer's invoice and a loan's last step were refused).
   * Unset: priority calls may use the whole window, as reserved ones do. */
  priorityPerMinute?: number;
}

/** Chosen by server code, never copied from a browser or an assistant's arguments. */
export interface BitrefillGuestCallOptionsV1 {
  priority?: boolean;
  /** Buying, or what a loan already under way needs: the last part of the window is kept for it. */
  reserved?: boolean;
}
type CallTierV1 = 'normal' | 'priority' | 'reserved';

/** A guest's token and its own rate window, for the tools one caller may use.
 * A tool outside that list is refused here, before anything is sent. */
export interface BitrefillGuestTransportV1 {
  callTool(name: string, args: Record<string, unknown>, options?: BitrefillGuestCallOptionsV1): Promise<SpendResultV1<string>>;
}

export function createBitrefillGuestTransportV1(tools: readonly string[], options: BitrefillGuestOptionsV1 = {}): BitrefillGuestTransportV1 {
  const clientId = options.clientId ?? STILL_BITREFILL_CLIENT_ID_V1;
  const endpoint = bitrefillMcpEndpointV1(options.affiliateCode);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const perMinute = options.perMinute ?? 20;
  const normalPerMinute = Math.min(perMinute, options.normalPerMinute ?? perMinute);
  const priorityPerMinute = Math.max(normalPerMinute, Math.min(perMinute, options.priorityPerMinute ?? perMinute));
  let token: { value: string; expiresAt: number } | null = null;
  let tokenRequest: Promise<SpendResultV1<string>> | null = null;
  let window: Array<{ at: number; tier: CallTierV1 }> = [];
  let id = 0;
  const refusedHere = (): SpendResultV1<never> => ({ ok: false, reason: 'bitrefill_rate_limited', local: true });

  function spend(tier: CallTierV1): boolean {
    const at = now();
    window = window.filter((entry) => at - entry.at < 60_000);
    if (window.length >= perMinute) return false;
    if (tier === 'normal' && window.filter((entry) => entry.tier === 'normal').length >= normalPerMinute) return false;
    if (tier === 'priority' && window.filter((entry) => entry.tier !== 'reserved').length >= priorityPerMinute) return false;
    window.push({ at, tier });
    return true;
  }

  /** The slot was acquired by guestToken, once for this actual OAuth request. */
  async function requestToken(): Promise<SpendResultV1<string>> {
    let response: Response;
    try {
      response = await partnerFetch(BITREFILL_MCP_TOKEN_URL_V1, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
          scope: 'mcp', resource: BITREFILL_MCP_URL_V1 }).toString(),
      }, { timeoutMs, fetchImpl: options.fetchImpl });
    } catch {
      return { ok: false, reason: 'bitrefill_unreachable' };
    }
    if (response.status === 429) return { ok: false, reason: 'bitrefill_rate_limited' };
    if (!response.ok) {
      // On 2026-11-02 this said "client_id metadata document URL is not trusted
      // by this authorization server", and every product and invoice failed
      // with it while the words were dropped here.
      const detail = spendRefusalDetailV1(refusalTextV1(await response.text().catch(() => '')));
      return { ok: false, reason: response.status >= 500 ? 'bitrefill_unreachable' : 'bitrefill_guest_refused', ...(detail ? { detail } : {}) };
    }
    const parsed = TokenSchemaV1.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { ok: false, reason: 'bitrefill_invalid_response' };
    // Ten minutes early, so a token never lapses between two calls of one read.
    const lifetime = (parsed.data.expires_in ?? 21_600) * 1000;
    token = { value: parsed.data.access_token, expiresAt: now() + Math.max(60_000, lifetime - 600_000) };
    return { ok: true, value: token.value };
  }

  async function guestToken(tier: CallTierV1): Promise<SpendResultV1<string>> {
    if (token && token.expiresAt > now()) return { ok: true, value: token.value };
    if (tokenRequest) return tokenRequest;
    // A locally refused request is not a token flight: a priority caller may still have a slot.
    if (!spend(tier)) return refusedHere();
    const pending = requestToken();
    tokenRequest = pending;
    try {
      return await pending;
    } finally {
      if (tokenRequest === pending) tokenRequest = null;
    }
  }

  async function callTool(name: string, args: Record<string, unknown>, tier: CallTierV1, retried = false): Promise<SpendResultV1<string>> {
    if (!tools.includes(name)) return { ok: false, reason: 'bitrefill_refused' };
    const bearer = await guestToken(tier);
    if (!bearer.ok) return bearer;
    if (!spend(tier)) return refusedHere();
    let response: Response;
    try {
      response = await partnerFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer.value}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      }, { timeoutMs, fetchImpl: options.fetchImpl });
    } catch {
      return { ok: false, reason: 'bitrefill_unreachable' };
    }
    if (response.status === 401 && !retried) {
      // A slower 401 for the previous token must not throw a newer token away.
      if (token?.value === bearer.value) token = null;
      return callTool(name, args, tier, true);
    }
    if (response.status === 429) return { ok: false, reason: 'bitrefill_rate_limited' };
    if (!response.ok) {
      const detail = spendRefusalDetailV1(refusalTextV1(await response.text().catch(() => '')));
      // A second 401, with a fresh token, is Bitrefill not letting Still in at all.
      return { ok: false, reason: response.status === 401 ? 'bitrefill_guest_refused' : 'bitrefill_refused', ...(detail ? { detail } : {}) };
    }
    const raw = await response.text().catch(() => '');
    // A stateless answer is one SSE event, or plain JSON.
    const data = raw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).pop() ?? raw;
    let json: unknown;
    try { json = JSON.parse(data); } catch { return { ok: false, reason: 'bitrefill_invalid_response' }; }
    const rpc = RpcSchemaV1.safeParse(json);
    if (!rpc.success || rpc.data.error || !rpc.data.result) return { ok: false, reason: 'bitrefill_invalid_response' };
    const text = rpc.data.result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    if (rpc.data.result.isError) {
      if (/not[_ ]found/i.test(text)) return { ok: false, reason: 'bitrefill_product_not_found' };
      const detail = spendRefusalDetailV1(text);
      return { ok: false, reason: 'bitrefill_refused', ...(detail ? { detail } : {}) };
    }
    return { ok: true, value: text };
  }

  return { callTool: (name, args, callOptions) => callTool(name, args, callOptions?.reserved === true ? 'reserved' : callOptions?.priority === true ? 'priority' : 'normal') };
}

export function createBitrefillGuestCatalogV1(options: BitrefillGuestOptionsV1 = {}): BitrefillGuestCatalogV1 {
  // One token and one 20-request window; browsing cannot spend the six checkout slots.
  const transport = createBitrefillGuestTransportV1(BITREFILL_GUEST_READ_TOOLS_V1, { perMinute: 20, normalPerMinute: 14, ...options });
  const callTool = (name: (typeof BITREFILL_GUEST_READ_TOOLS_V1)[number], args: Record<string, unknown>, callOptions?: BitrefillGuestCallOptionsV1) => transport.callTool(name, args, callOptions);

  function decode<S extends z.ZodTypeAny>(text: string, schema: S): SpendResultV1<z.output<S>> {
    let value: unknown;
    try { value = decodeToonV1(text); } catch (error) {
      if (error instanceof ToonParseError) return { ok: false, reason: 'bitrefill_invalid_response' };
      throw error;
    }
    const parsed = schema.safeParse(value);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'bitrefill_invalid_response' };
  }

  return {
    async search(input) {
      if (!COUNTRY_V1.test(input.country)) return { ok: false, reason: 'bitrefill_refused' };
      const answer = await callTool('search-products', {
        query: input.query?.trim() || '*',
        intent: 'Show what a loan against tokenized stocks could pay for, with prices in USDC',
        country: input.country,
        product_type: input.type,
        in_stock: true,
        per_page: 30,
      });
      if (!answer.ok) return answer;
      const parsed = decode(answer.value, SearchSchemaV1);
      if (!parsed.ok) return parsed;
      return {
        ok: true,
        value: parsed.value.products
          .filter((product) => SLUG_V1.test(product.slug))
          .map((product) => ({
            id: product.slug,
            name: product.name.slice(0, 120),
            countries: (product.countries ?? []).filter((code) => COUNTRY_V1.test(code)).slice(0, 60),
            inStock: product.in_stock !== false,
          })),
      };
    },

    async product(productId, readOptions) {
      if (!SLUG_V1.test(productId)) return { ok: false, reason: 'bitrefill_product_not_found' };
      const answer = await callTool('get-product-details', { product_id: productId, currency: 'USDC' },
        { priority: readOptions?.freshForCheckout === true });
      if (!answer.ok) return answer;
      const parsed = decode(answer.value, DetailSchemaV1);
      if (!parsed.ok) return parsed;
      const detail = parsed.value;
      if (detail.id !== productId) return { ok: false, reason: 'bitrefill_invalid_response' };
      // Only packages priced in USDC: a price in anything else is not this answer.
      const packages = (detail.packages ?? [])
        .filter((row) => row.payment_currency === 'USDC' && PRICE_V1.test(row.payment_price))
        .map((row) => ({
          value: row.package_value.slice(0, 80),
          faceCurrency: row.package_currency && /^[A-Z]{3}$/.test(row.package_currency) ? row.package_currency : null,
          priceUsdc: row.payment_price,
        }));
      return {
        ok: true,
        value: {
          id: detail.id,
          name: detail.name.slice(0, 120),
          country: detail.country_code && COUNTRY_V1.test(detail.country_code) ? detail.country_code : null,
          inStock: detail.in_stock !== false,
          recipientType: detail.recipient_type?.slice(0, 40) ?? null,
          packages,
          url: detail.url && /^https:\/\/www\.bitrefill\.com\//.test(detail.url) ? detail.url : null,
          // Mobile Legends, 2026-11-02: "This product requires bill_payment_id".
          prepayment: detail.prepayment !== undefined && detail.prepayment !== null,
        },
      };
    },
  };
}
