import { partnerFetch } from '@mioagent/security';
import { logger } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// What Coinbase publishes about its own tokens that a list needs: the company
// name and an icon.
//
// Read from Coinbase's public Tokenized Stocks API, the one Base's docs point
// integrators to ("each token's contract address, symbol, name, decimals, icon
// URL…"). It is DECORATION here, never membership: which addresses are
// official is decided by the reviewed ingest, and a row this reader cannot
// parse is skipped rather than refusing the rest. An outage keeps the last
// good answer, so a list never loses its names because one fetch failed.
//
// The icons are served from our own origin. A reader's browser never asks
// Coinbase for anything, and only one URL shape is ever fetched — the content
// hash Coinbase names its icons by.
// ---------------------------------------------------------------------------

export const COINBASE_TOKENIZED_STOCKS_URL_V1 = 'https://api.coinbase.com/v1/tokenized-stocks';
const ICON_URL_SHAPE_V1 = /^https:\/\/metadata\.coinbase\.com\/equity_icons\/[0-9a-f]{64}\.png$/;
const ADDRESS_SHAPE_V1 = /^0x[0-9a-f]{40}$/;
const PNG_SIGNATURE_V1 = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Coinbase's icons are about 21 KB; a quarter of a megabyte is headroom. */
export const STOCK_ICON_MAX_BYTES_V1 = 256 * 1024;

export interface CoinbaseStockMetaV1 {
  tokenAddress: string;
  symbol: string;
  name: string;
  iconUrl: string | null;
}

/** Rows that fail their shape are skipped; the response as a whole is not
 * refused, because none of this decides membership. */
export function parseCoinbaseStockMetaV1(body: unknown): Map<string, CoinbaseStockMetaV1> {
  const rows = new Map<string, CoinbaseStockMetaV1>();
  const tokens = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(tokens)) return rows;
  for (const raw of tokens.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const tokenAddress = typeof row.contract_address === 'string' ? row.contract_address.toLowerCase() : '';
    if (!ADDRESS_SHAPE_V1.test(tokenAddress)) continue;
    const symbol = typeof row.symbol === 'string' ? row.symbol.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!/^[A-Za-z0-9.-]{1,16}$/.test(symbol) || name.length === 0 || name.length > 120) continue;
    const iconUrl = typeof row.icon_url === 'string' && ICON_URL_SHAPE_V1.test(row.icon_url) ? row.icon_url : null;
    rows.set(tokenAddress, { tokenAddress, symbol, name, iconUrl });
  }
  return rows;
}

export function isPngV1(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE_V1.length && PNG_SIGNATURE_V1.every((byte, index) => bytes[index] === byte);
}

export interface CoinbaseStockMetaCacheOptionsV1 {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a good answer is used before it is read again. */
  ttlMs?: number;
  /** After a failure, how long until the next attempt. */
  retryMs?: number;
}

export function createCoinbaseStockMetaCacheV1(options: CoinbaseStockMetaCacheOptionsV1 = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 6 * 3_600_000;
  const retryMs = options.retryMs ?? 10 * 60_000;
  let good: Map<string, CoinbaseStockMetaV1> = new Map();
  let nextAt = 0;
  let inflight: Promise<Map<string, CoinbaseStockMetaV1>> | null = null;
  const icons = new Map<string, Promise<Uint8Array | null>>();

  async function fetchMeta(): Promise<Map<string, CoinbaseStockMetaV1>> {
    try {
      const response = await partnerFetch(
        COINBASE_TOKENIZED_STOCKS_URL_V1,
        { headers: { accept: 'application/json' } },
        { timeoutMs: 8_000, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
      );
      if (!response.ok) throw new Error(`coinbase_stocks_http_${response.status}`);
      const parsed = parseCoinbaseStockMetaV1(await response.json());
      if (parsed.size === 0) throw new Error('coinbase_stocks_empty');
      good = parsed;
      nextAt = now() + ttlMs;
    } catch (error) {
      // The last good answer stays; only the next attempt moves.
      nextAt = now() + retryMs;
      logger.warn('Coinbase stock metadata read failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        detail: error instanceof Error ? error.message.slice(0, 80) : undefined,
      });
    }
    return good;
  }

  return {
    async read(): Promise<ReadonlyMap<string, CoinbaseStockMetaV1>> {
      if (now() < nextAt) return good;
      inflight ??= fetchMeta().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /**
     * The icon for one token, as PNG bytes, or null.
     *
     * Only an address Coinbase's own answer lists, and only the URL that answer
     * gave for it. A failed fetch is not remembered, so the next reader tries
     * again; a good one is kept for the life of the process (a few dozen small
     * files, content-addressed by Coinbase).
     */
    async icon(tokenAddress: string): Promise<Uint8Array | null> {
      const meta = (await this.read()).get(tokenAddress.toLowerCase());
      if (!meta?.iconUrl) return null;
      const cached = icons.get(meta.iconUrl);
      if (cached) return cached;
      const loading = (async () => {
        const response = await partnerFetch(
          meta.iconUrl!,
          {},
          { timeoutMs: 8_000, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
        );
        if (!response.ok) return null;
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > STOCK_ICON_MAX_BYTES_V1) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.length <= STOCK_ICON_MAX_BYTES_V1 && isPngV1(bytes) ? bytes : null;
      })().catch(() => null);
      icons.set(meta.iconUrl, loading);
      const bytes = await loading;
      if (bytes === null) icons.delete(meta.iconUrl);
      // A bound, not a policy: Coinbase lists 58 tokens today.
      while (icons.size > 256) {
        const oldest = icons.keys().next();
        if (oldest.done) break;
        icons.delete(oldest.value);
      }
      return bytes;
    },
  };
}

export type CoinbaseStockMetaCacheV1 = ReturnType<typeof createCoinbaseStockMetaCacheV1>;
