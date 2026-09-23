import express, { Router, type Request, type Response } from 'express';
import { logger } from '@mioagent/utils';

import {
  SPONSORED_GAS_RPC_ERROR_CODE_V1,
  SPONSORED_GAS_TOKEN_TTL_MS_V1,
  createSponsorshipLedgerV1,
  decideSponsoredGasV1,
  issueSponsorshipTokenV1,
  paymasterUpstreamUrlV1,
  sponsoredCallsDigestV1,
  sponsoredGasDailyLimitV1,
  sponsorshipKeyV1,
  type SponsoredCallV1,
} from '../lib/sponsoredGas.js';

// ---------------------------------------------------------------------------
// /api/paymaster — the ERC-7677 endpoint Base Account is pointed at.
//
// Mounted BEFORE the app's CORS and session middleware, on purpose: the wallet
// calls this from its own origin with no Miorail cookie, so neither would help
// and the CORS one would answer the preflight with no allowed origin. What
// authorises a request is the sponsorship token in the URL the offer named
// (`/api/paymaster/sponsorship/<token>`), or in the ERC-7677 context for a
// wallet that forwards one — see `lib/sponsoredGas.ts` for the whole policy.
// Mounted before the request logger too, so the token is not written to our
// log; nginx does not log this location either.
// ---------------------------------------------------------------------------

export const sponsoredGasRuntime = {
  upstreamUrl: (): string | null => paymasterUpstreamUrlV1(process.env),
  key: (): Buffer | null => sponsorshipKeyV1(process.env),
  dailyLimit: (): number => sponsoredGasDailyLimitV1(process.env),
  origin: (): string => process.env.MIORAIL_PUBLIC_ORIGIN?.trim() || 'https://miorail.xyz',
  now: (): Date => new Date(),
  /** The one place the upstream URL is used. It is never logged. */
  forward: async (url: string, body: unknown): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return response.json();
  },
};

export const sponsorshipLedgerV1 = createSponsorshipLedgerV1({
  limit: () => sponsoredGasRuntime.dailyLimit(),
  now: () => sponsoredGasRuntime.now(),
});

export interface SponsorshipOfferV1 {
  /**
   * Where the wallet sends `pm_*` requests: this server, never Coinbase's URL.
   * The token is in the path, because Base Account does not pass the
   * capability's `context` on to the paymaster.
   */
  paymasterUrl: string;
  /** The same token, as the ERC-7677 `context`, for a wallet that forwards it. */
  context: { sponsorship: string };
}

/** Whether this server can sponsor anything at all right now. */
export function sponsoredGasConfiguredV1(): boolean {
  return (
    sponsoredGasRuntime.upstreamUrl() !== null &&
    sponsoredGasRuntime.key() !== null &&
    sponsoredGasRuntime.dailyLimit() > 0
  );
}

/**
 * A sponsorship for exactly these calls from exactly this wallet, or null.
 *
 * Null when sponsorship is not configured or today's limit for this wallet is
 * spent — in both cases the review must not say "gas paid by Miorail", so the
 * decision is made here, once, rather than discovered in the wallet.
 */
export function offerSponsorshipV1(input: {
  wallet: string;
  blueprintId: string;
  calls: readonly SponsoredCallV1[];
}): SponsorshipOfferV1 | null {
  const key = sponsoredGasRuntime.key();
  if (!key || !sponsoredGasConfiguredV1()) return null;
  if (!sponsorshipLedgerV1.allows(input.wallet, null)) return null;
  const token = issueSponsorshipTokenV1(
    {
      v: 1,
      wallet: input.wallet.toLowerCase(),
      blueprintId: input.blueprintId,
      digest: sponsoredCallsDigestV1(input.calls),
      expiresAt: sponsoredGasRuntime.now().getTime() + SPONSORED_GAS_TOKEN_TTL_MS_V1,
    },
    key,
  );
  return {
    paymasterUrl: `${sponsoredGasRuntime.origin().replace(/\/+$/, '')}/api/paymaster/sponsorship/${token}`,
    context: { sponsorship: token },
  };
}

/**
 * The offer for an approved swap, when one of its assets is a reviewed stock.
 *
 * The assets are the stored Blueprint's own expected changes and the check is
 * the reviewed corpus, so the decision rests on nothing the client sent. A
 * swap of two tokens outside the corpus is not offered anything, and nothing
 * is looked up at all while sponsorship is off.
 */
export async function approvedStockSponsorshipV1(input: {
  assets: readonly (string | null)[];
  isReviewedStock: (tokenAddress: string) => Promise<boolean>;
  wallet: string;
  blueprintId: string;
  calls: readonly SponsoredCallV1[];
}): Promise<SponsorshipOfferV1 | null> {
  if (!sponsoredGasConfiguredV1()) return null;
  for (const address of input.assets) {
    if (address && (await input.isReviewedStock(address))) {
      return offerSponsorshipV1({ wallet: input.wallet, blueprintId: input.blueprintId, calls: input.calls });
    }
  }
  return null;
}

export const sponsoredGasRouter = Router();

sponsoredGasRouter.use((_req: Request, res: Response, next) => {
  // No credentials are ever read here, so any origin may ask. The wallet's
  // origin is the wallet's business, and this endpoint is useless without a
  // token only this server can sign.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

sponsoredGasRouter.options(['/', '/sponsorship/:token'], (_req: Request, res: Response) => {
  res.status(204).end();
});

/**
 * Whether a page may say "the network fee is on us" before anything is
 * approved. A public fact about this server — on or off, and the per-wallet
 * limit — with nothing about the upstream in it.
 */
sponsoredGasRouter.get('/status', (_req: Request, res: Response) => {
  const on = sponsoredGasConfiguredV1();
  res.status(200).json({
    schemaVersion: 'sponsored-gas-status/v1',
    sponsoredGas: on ? 'on' : 'off',
    dailyLimitPerWallet: on ? sponsoredGasRuntime.dailyLimit() : null,
    scope: 'reviewed_stock_swaps',
    wallets: 'base_account',
  });
});

/** A JSON-RPC method name is ours to log only when it is one: it may name what
 * a wallet asks for, never carry what it sent. */
function loggableMethodV1(method: unknown): string | null {
  return typeof method === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method) ? method : null;
}

sponsoredGasRouter.post(['/', '/sponsorship/:token'], express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
  const body = req.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | undefined;
  const id = typeof body?.id === 'number' || typeof body?.id === 'string' ? body.id : null;
  const reply = (payload: { result: unknown } | { error: { code: number; message: string; data?: unknown } }) => {
    res.status(200).json({ jsonrpc: '2.0', id, ...payload });
  };
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    reply({ error: { code: -32600, message: 'Expected a JSON-RPC 2.0 request.' } });
    return;
  }
  const upstreamUrl = sponsoredGasRuntime.upstreamUrl();
  const key = sponsoredGasRuntime.key();
  if (!upstreamUrl || !key || sponsoredGasRuntime.dailyLimit() === 0) {
    reply({
      error: { code: -32601, message: 'Sponsored gas is not configured on this server.', data: { reason: 'not_configured' } },
    });
    return;
  }

  const urlToken = typeof req.params.token === 'string' ? req.params.token : null;
  const decision = decideSponsoredGasV1({
    method: body.method,
    params: body.params,
    urlToken,
    key,
    nowMs: sponsoredGasRuntime.now().getTime(),
    ledger: sponsorshipLedgerV1,
  });
  if (!decision.ok) {
    // Which method a wallet asked for is what showed Base Account opens with
    // one we do not serve; whether the request came in on a token URL is what
    // tells an old offer from a lost token.
    logger.info('Sponsored gas refused', {
      reason: decision.code,
      method: decision.code === 'method_not_supported' ? loggableMethodV1(body.method) : undefined,
      tokenUrl: urlToken !== null,
    });
    reply({
      error: {
        code: SPONSORED_GAS_RPC_ERROR_CODE_V1[decision.code],
        message: decision.message,
        data: { reason: decision.code },
      },
    });
    return;
  }

  // The user operation goes upstream unchanged; OUR context does not — the
  // token is Miorail's business, not the paymaster's.
  const [userOp, entryPoint, chainId] = body.params as [unknown, unknown, unknown];
  let upstream: unknown;
  try {
    upstream = await sponsoredGasRuntime.forward(upstreamUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: decision.method,
      params: [userOp, entryPoint, chainId, {}],
    });
  } catch (cause) {
    logger.warn('Sponsored gas upstream did not answer', {
      errorName: cause instanceof Error ? cause.name : typeof cause,
    });
    reply({ error: { code: -32603, message: 'The paymaster did not answer.', data: { reason: 'upstream_unavailable' } } });
    return;
  }

  const answer = upstream as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (!answer || answer.result === undefined) {
    // The upstream's words are logged (bounded) for the operator — a spent
    // budget or a contract off the allowlist reads exactly like this — and
    // never passed to the wallet, which gets one plain sentence.
    logger.warn('Sponsored gas upstream declined', {
      upstreamCode: typeof answer?.error?.code === 'number' ? answer.error.code : null,
      upstreamMessage: typeof answer?.error?.message === 'string' ? answer.error.message.slice(0, 160) : null,
    });
    reply({
      error: {
        code: -32603,
        message: 'The paymaster declined to sponsor this operation.',
        data: { reason: 'upstream_declined' },
      },
    });
    return;
  }

  // Counted only when the paymaster has agreed to the FINAL data: a stub is an
  // estimate, and an operation the upstream refused was never sponsored.
  if (decision.method === 'pm_getPaymasterData') {
    sponsorshipLedgerV1.record(decision.wallet, decision.nonce);
    logger.info('Sponsored gas granted', { blueprintId: decision.claim.blueprintId, tokenSource: decision.tokenSource });
  }
  reply({ result: answer.result });
});
