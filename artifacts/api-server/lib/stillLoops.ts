import type { SpendInvoiceStatusNameV1 } from '@mioagent/commerce-engine';
import { client } from '@mioagent/db';
import {
  createDatabaseStillLoopRepositoryV1,
  type SqlTemplateExecutor,
  type StillLoopCandidateV1,
  type StillLoopRepositoryV1,
  type StillLoopV1,
  type StillLoopViaV1,
} from '@mioagent/route-storage';
import { loopBrandOfV1 } from '@mioagent/still-engine/loops';
import { logger } from '@mioagent/utils';

import type { LendingOriginV1 } from './lendingDraft.js';
import type { LoanExecutionV1 } from './loanExecutionStore.js';
import { shareAmountAtomicV1, stillSpendShareOfV1 } from './stillSpendShare.js';

// ---------------------------------------------------------------------------
// Loops on the server: which confirmed loans are Loops, and Bitrefill's word
// on their cards.
//
// A Loop is written when its owner's page or assistant reads the loan as
// confirmed: that read already happens, and it is when Still still holds the
// open order and can ask Bitrefill whether the card arrived. Nothing here is
// in the loan's path: a failure to write a Loop is logged, never the loan's.
// Counted only while STILL_LOOPS_V1=on.
// ---------------------------------------------------------------------------

export function stillLoopsEnabledV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STILL_LOOPS_V1 ?? '').trim().toLowerCase() === 'on';
}

/** The Still team's wallets (STILL_TEAM_WALLETS, comma separated): their Loops are shown as the team's,
 * and never counted. A value that is not an address is left out. */
export function stillTeamWalletsV1(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.STILL_TEAM_WALLETS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter((value) => /^0x[0-9a-f]{40}$/.test(value)));
}

export function stillLoopViaV1(origin: LendingOriginV1 | undefined): StillLoopViaV1 {
  if (!origin) return 'web';
  return origin.client === 'other' ? 'assistant' : origin.client;
}

/** The Loop a confirmed loan made, or null: it paid a Bitrefill card of the company whose stock it pledged. */
export function stillLoopCandidateOfV1(execution: LoanExecutionV1, team: ReadonlySet<string>): StillLoopCandidateV1 | null {
  const share = stillSpendShareOfV1(execution);
  const facts = execution.run.facts;
  const payment = facts.payment;
  if (!share || !payment?.productId) return null;
  const brand = loopBrandOfV1({ collateralTokenAddress: facts.collateralTokenAddress, productId: payment.productId });
  if (!brand) return null;
  const wallet = execution.walletAddress.toLowerCase();
  return {
    executionId: execution.executionId,
    walletAddress: wallet,
    brand: brand.brand,
    collateral: brand.collateral as StillLoopCandidateV1['collateral'],
    productId: payment.productId,
    productName: share.productName,
    packageLabel: share.packageLabel,
    priceRoundedAtomic: shareAmountAtomicV1(share.priceAtomic),
    venue: share.venue,
    via: stillLoopViaV1(facts.origin),
    team: team.has(wallet),
    confirmedAt: execution.updatedAt,
  };
}

/** Bitrefill's invoice states that settle a Loop's card: delivered, or stopped. */
export function stillLoopDeliveryOfV1(status: SpendInvoiceStatusNameV1 | null | undefined): 'complete' | 'blocked' | 'denied' | 'payment_error' | null {
  return status === 'complete' || status === 'blocked' || status === 'denied' || status === 'payment_error' ? status : null;
}

/** Writes the Loop a confirmed loan made, and Bitrefill's word on its card when it has one. */
export async function noteStillLoopV1(input: {
  execution: LoanExecutionV1;
  invoiceStatus: SpendInvoiceStatusNameV1 | null | undefined;
  repository: StillLoopRepositoryV1;
  team: ReadonlySet<string>;
  now: Date;
}): Promise<StillLoopV1 | null> {
  const candidate = stillLoopCandidateOfV1(input.execution, input.team);
  if (!candidate) return null;
  const [written] = await input.repository.record([candidate]);
  if (!written) return null;
  const delivery = stillLoopDeliveryOfV1(input.invoiceStatus);
  return delivery ? (await input.repository.markDelivery({ executionId: written.executionId, outcome: delivery, at: input.now })) ?? written : written;
}

/** What the loan's own result says of its Loop: its number, and whether the card arrived. */
export interface StillLoopWireV1 {
  loopNo: number;
  brand: StillLoopV1['brand'];
  complete: boolean;
  undelivered: StillLoopV1['undelivered'];
  onWall: boolean;
  team: boolean;
}

export function stillLoopWireV1(loop: StillLoopV1): StillLoopWireV1 {
  return { loopNo: loop.loopNo, brand: loop.brand, complete: loop.deliveredAt !== null, undelivered: loop.undelivered, onWall: loop.onWall, team: loop.team };
}

export const stillLoopsRuntimeV1 = {
  enabled: (): boolean => stillLoopsEnabledV1(),
  team: (): ReadonlySet<string> => stillTeamWalletsV1(),
  repository: (): StillLoopRepositoryV1 => createDatabaseStillLoopRepositoryV1(client as unknown as SqlTemplateExecutor),
  now: (): Date => new Date(),
};

/** The Loop a loan read as confirmed made, written if it was not; null for any other loan, while Loops are
 * off, and when writing failed, which is logged and never the loan's answer. */
export async function stillLoopOfExecutionV1(
  execution: LoanExecutionV1,
  invoiceStatus: SpendInvoiceStatusNameV1 | null | undefined = null,
): Promise<StillLoopV1 | null> {
  if (!stillLoopsRuntimeV1.enabled() || execution.state !== 'confirmed' || !execution.run.facts.payment) return null;
  try {
    return await noteStillLoopV1({
      execution, invoiceStatus, repository: stillLoopsRuntimeV1.repository(), team: stillLoopsRuntimeV1.team(), now: stillLoopsRuntimeV1.now(),
    });
  } catch (error) {
    logger.warn('Still Loop not written', { errorName: error instanceof Error ? error.name : typeof error });
    return null;
  }
}
