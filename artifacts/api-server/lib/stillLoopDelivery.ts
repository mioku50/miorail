import { client } from '@mioagent/db';
import { decrypt, deriveKey, encrypt } from '@mioagent/crypto';
import {
  createDatabaseStillLoopInvoiceReadRepositoryV1,
  type SqlTemplateExecutor,
  type StillLoopInvoiceReadRepositoryV1,
} from '@mioagent/route-storage';
import { LOOP_BRANDS_V1 } from '@mioagent/still-engine/loops';
import { logger } from '@mioagent/utils';

import type { LoanExecutionV1, LoanOwnerV1 } from './loanExecutionStore.js';
import { stillLoopOfExecutionV1, stillLoopsRuntimeV1 } from './stillLoops.js';

// ---------------------------------------------------------------------------
// A Loop's card, read until Bitrefill has said what became of it (audit LOOP-1, 2026-11-21).
//
// Bitrefill reads an invoice back only with its access token, and Still held the token with the open order, half an
// hour in memory: a card delivered after that, or after a restart, left its Loop "on its way" for good while the draw
// counted it. So for an invoice of a Loop brand's card, and only that, {invoice id, access token} is kept encrypted
// (lib/db/drizzle/0108), and a ten-minute tick asks Bitrefill again for each Loop that has no word yet, until it has
// one or 14 days have passed. The kept row goes once the word is in. The email and any number stay in memory only.
// ---------------------------------------------------------------------------

/** How long a Loop's card is asked after: Bitrefill delivers in minutes, and a refund takes days at most. */
export const STILL_LOOP_DELIVERY_ASKED_FOR_MS_V1 = 14 * 24 * 3_600_000;
/** One read of one invoice at most this often. */
const READ_AGAIN_AFTER_MS_V1 = 9 * 60_000;
const SALT_V1 = 'still-loop-invoice-read/v1';

export const stillLoopInvoiceReadsRuntimeV1 = {
  repository: (): StillLoopInvoiceReadRepositoryV1 => createDatabaseStillLoopInvoiceReadRepositoryV1(client as unknown as SqlTemplateExecutor),
  secret: (): string => process.env.SESSION_SECRET ?? '',
  now: (): Date => new Date(),
};

/** Whether a product is one a Loop can be made of: a card of one of the five brands. */
export function stillLoopProductV1(productId: string): boolean {
  return LOOP_BRANDS_V1.some((brand) => brand.productIds.some((pattern) => pattern.test(productId)));
}

const keyV1 = (secret: string) => deriveKey(secret, SALT_V1);

/** Keeps what reads this invoice again, for a Loop brand's card only; never in the order's way. */
export async function keepStillLoopInvoiceReadV1(order: { orderId: string; walletAddress: string; productId: string; accessToken: string }): Promise<void> {
  const runtime = stillLoopInvoiceReadsRuntimeV1;
  const secret = runtime.secret();
  if (!stillLoopsRuntimeV1.enabled() || !stillLoopProductV1(order.productId) || secret.length < 16) return;
  try {
    const readEnc = encrypt(JSON.stringify({ invoiceId: order.orderId, accessToken: order.accessToken }), keyV1(secret));
    await runtime.repository().keep({ orderId: order.orderId, walletAddress: order.walletAddress, readEnc, at: runtime.now() });
  } catch (error) {
    logger.warn('Still Loop invoice read not kept', { errorName: error instanceof Error ? error.name : typeof error });
  }
}

/** What reads a kept invoice again, or null: none was kept, or it cannot be opened. */
export async function stillLoopKeptInvoiceRefV1(owner: LoanOwnerV1, orderId: string): Promise<{ orderId: string; accessToken: string } | null> {
  const runtime = stillLoopInvoiceReadsRuntimeV1;
  const secret = runtime.secret();
  if (secret.length < 16) return null;
  try {
    const row = await runtime.repository().get({ orderId, walletAddress: owner.walletAddress });
    if (!row) return null;
    const read = JSON.parse(decrypt(row.readEnc, keyV1(secret))) as { invoiceId?: unknown; accessToken?: unknown };
    return read.invoiceId === orderId && typeof read.accessToken === 'string' ? { orderId, accessToken: read.accessToken } : null;
  } catch {
    return null;
  }
}

export interface StillLoopDeliveryDepsV1 {
  /** The confirmed loan a Loop was made of. */
  loanOf(owner: LoanOwnerV1, executionId: string): Promise<LoanExecutionV1 | null>;
  /** Bitrefill's status name for the invoice, or null when it could not be read now. */
  readInvoice(owner: LoanOwnerV1, ref: { orderId: string; accessToken: string }): Promise<string | null>;
}

/** One pass: each Loop with no word on its card asked once more, at most every nine minutes, and old reads dropped. */
export async function settleStillLoopDeliveriesV1(deps: StillLoopDeliveryDepsV1): Promise<{ asked: number; settled: number }> {
  const runtime = stillLoopInvoiceReadsRuntimeV1;
  if (!stillLoopsRuntimeV1.enabled()) return { asked: 0, settled: 0 };
  const now = runtime.now();
  const reads = runtime.repository();
  await reads.prune({ before: new Date(now.getTime() - STILL_LOOP_DELIVERY_ASKED_FOR_MS_V1) });
  let asked = 0, settled = 0;
  for (const loop of await stillLoopsRuntimeV1.repository().awaitingDelivery({ since: new Date(now.getTime() - STILL_LOOP_DELIVERY_ASKED_FOR_MS_V1), limit: 20 })) {
    const owner = { tenantId: `eip155:8453:${loop.walletAddress}`, walletAddress: loop.walletAddress };
    const loan = await deps.loanOf(owner, loop.executionId).catch(() => null);
    const orderId = loan?.run.facts.payment?.orderId;
    if (!loan || !orderId) continue;
    const kept = await reads.get({ orderId, walletAddress: loop.walletAddress });
    if (!kept || (kept.readAt !== null && now.getTime() - Date.parse(kept.readAt) < READ_AGAIN_AFTER_MS_V1)) continue;
    const ref = await stillLoopKeptInvoiceRefV1(owner, orderId);
    if (!ref) continue;
    asked += 1;
    await reads.touched({ orderId, at: now });
    const status = await deps.readInvoice(owner, ref).catch(() => null);
    if (!status) continue;
    const after = await stillLoopOfExecutionV1(loan, status as Parameters<typeof stillLoopOfExecutionV1>[1]);
    if (after && (after.deliveredAt !== null || after.undelivered !== null)) {
      settled += 1;
      await reads.forget({ orderId });
    }
  }
  return { asked, settled };
}

/** Every ten minutes while Loops are on; the timer never keeps the process up. */
export function startStillLoopDeliveryTickerV1(deps: StillLoopDeliveryDepsV1, intervalMs = 10 * 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running || !stillLoopsRuntimeV1.enabled()) return;
    running = true;
    settleStillLoopDeliveriesV1(deps)
      .then((done) => { if (done.asked > 0) logger.info('Still Loop cards asked again', done); })
      .catch((error: unknown) => { logger.warn('Still Loop cards not asked', { errorName: error instanceof Error ? error.name : typeof error }); })
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
