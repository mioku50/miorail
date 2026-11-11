import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@mioagent/utils';

import { rwaLendingRouter } from '../rwaLending.js';
import { McpAuditUnavailableError, recordAuditV1 } from './audit.js';
import type { McpPrivateIdentityV1 } from './session.js';
import { STILL_PUBLIC_HOST_V1 } from '../../lib/stillOrigin.js';
import { spendDeliveryMaskedV1 } from '../../lib/stillSpendOrders.js';

// ---------------------------------------------------------------------------
// The review card's own way to the lending review, as the grant's wallet.
//
// Still's card in an assistant's chat (stillCard.ts) shows the review
// Still's site shows and sends it from the person's own wallet through
// WalletConnect. It asks for the review, arms it, records what the wallet sent
// and reads the result through this one tool, which hands each request to
// rwaLendingRouter itself with the grant's wallet as the session: the same
// draft check, the same fresh gate and simulation, the same single
// submission. Nothing here decides anything the page does not.
//
// A ready review carries executable calls, so this is the card's tool alone:
// hidden from the model by the host (visibility ["app"]), listed only to a
// client that said it draws apps, and a ready review is recorded as
// action_released before it leaves, like every release on this surface. No
// row, no calls.
// ---------------------------------------------------------------------------

export const STILL_CARD_LENDING_TOOL_V1 = 'still_card_lending';
const ROOT_V1 = '/api/route-intelligence';
const PATH_V1 = /^\/api\/route-intelligence\/rwa\/lending\/(?:review\/[A-Za-z0-9._-]{1,6000}(?:\?delivery=sequential)?|executions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/(?:arm|submission|transaction|steps|stop))?)$/;

export const StillCardLendingInputV1Schema = z.object({
  method: z.enum(['GET', 'POST']),
  path: z.string().max(7000).regex(PATH_V1),
  body: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const StillCardLendingOutputV1Schema = z.object({
  status: z.number().int(),
  body: z.unknown(),
  /** The grant's wallet: the card connects only this one. */
  wallet: z.string(),
}).strict();

type AnswerV1 = { status: number; body: unknown };

/** One request to the page's own lending routes, as this grant's wallet. */
function routeV1(identity: McpPrivateIdentityV1, method: 'GET' | 'POST', path: string, body: Record<string, unknown>): Promise<AnswerV1> {
  const url = path.slice(ROOT_V1.length);
  const [pathname = '', search = ''] = url.split('?');
  return new Promise<AnswerV1>((resolve, reject) => {
    let status = 200;
    const res = {
      status(code: number) { status = code; return res; },
      json(value: unknown) { resolve({ status, body: value }); return res; },
      setHeader() { return res; },
    };
    // Exactly what the routes read: the session's wallet, the path, the query and the body.
    const req = {
      method, url, originalUrl: url, path: pathname, query: Object.fromEntries(new URLSearchParams(search)), body, headers: {},
      session: { user: { id: identity.tenantId, address: identity.walletAddress.toLowerCase(), chainId: 8453 } },
    };
    rwaLendingRouter(req as unknown as Request, res as unknown as Response,
      (error?: unknown) => (error ? reject(error) : resolve({ status: 404, body: { error: 'lending_route_not_found' } })));
  });
}

/** A route's answer as the card may carry it. Where a purchase goes is shown on the card too, and never
 * repeated in full through an assistant's tool result: only enough to know one's own email and number by
 * (audit MCP-3, 2026-11-10). Anything else passes as it is. Exported for its test. */
export function cardReviewBodyV1(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('deliverTo' in body)) return body;
  const { deliverTo, ...rest } = body as Record<string, unknown>;
  const given = deliverTo as { email?: unknown; phone?: unknown } | null;
  // A shape that is not one is dropped, not passed on.
  if (!given || typeof given !== 'object' || typeof given.email !== 'string' || !given.email.includes('@') || !(given.phone === null || typeof given.phone === 'string')) return rest;
  return { ...rest, deliverTo: spendDeliveryMaskedV1({ email: given.email, phone: given.phone }) };
}

export async function stillCardLendingV1(identity: McpPrivateIdentityV1, args: z.infer<typeof StillCardLendingInputV1Schema>): Promise<z.infer<typeof StillCardLendingOutputV1Schema>> {
  const wallet = identity.walletAddress.toLowerCase();
  const writes = /\/(?:arm|submission|transaction|steps|stop)$/.test(args.path);
  if ((args.method === 'POST') !== writes) return { status: 400, body: { error: 'lending_request_invalid' }, wallet };
  const routed = await routeV1(identity, args.method, args.path, args.body ?? {});
  const answer = { status: routed.status, body: cardReviewBodyV1(routed.body) };
  const review = answer.body as { state?: unknown; executionId?: unknown; callsHash?: unknown } | null;
  if (args.path.includes('/review/') && answer.status === 200 && review?.state === 'ready') {
    try {
      await recordAuditV1({ tokenId: identity.tokenId, tenantId: identity.tenantId, walletAddress: wallet, toolName: STILL_CARD_LENDING_TOOL_V1,
        outcome: 'action_released', planId: typeof review.executionId === 'string' ? review.executionId : null,
        callsHash: typeof review.callsHash === 'string' ? review.callsHash : null });
    } catch (error) {
      if (!(error instanceof McpAuditUnavailableError)) throw error;
      logger.warn('Still card review withheld: the release could not be audited', { tenantId: identity.tenantId });
      return { status: 503, body: { error: 'lending_unavailable', detail: `Still could not record this review, so it was not handed to the card. Open it on ${STILL_PUBLIC_HOST_V1} instead.` }, wallet };
    }
  }
  return { ...answer, wallet };
}
