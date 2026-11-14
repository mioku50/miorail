import { InMemoryRateLimiter } from '@mioagent/utils';

// ---------------------------------------------------------------------------
// How often a send from holdings may be priced (audit SS-6, 2026-11-14).
//
// A stock or gold sent from the wallet is priced as what it would fetch in
// USDC now: one quote from Uniswap and one from KyberSwap, for every answer of
// `/gift/holding` and every `/gift/send/prepare`. Nothing bounded that but the
// API's own limit of 100 requests a minute per IP and path, so one signed-in
// wallet could ask the two routers about 400 times a minute, on the same shared
// keys the sell review, Swap AI and the hourly cash-exit pass run on, and the
// team had already slowed that pass down to stay under them.
//
// Now a send is priced at the sell review's rate, ten times a minute for one
// wallet, and the whole server prices at most sixty a minute, however many
// wallets ask. A price refused here asks no router.
// ---------------------------------------------------------------------------

/** Sends priced per minute for one wallet: the sell review's own rate. */
export const SEND_VALUATIONS_PER_WALLET_PER_MINUTE_V1 = 10;
/** Sends priced per minute for the whole server. */
export const SEND_VALUATIONS_PER_MINUTE_V1 = 60;

export class SendValuationBusyErrorV1 extends Error {
  constructor(readonly scope: 'wallet' | 'server') {
    super(scope === 'wallet'
      ? `Miorail prices a send at most ${SEND_VALUATIONS_PER_WALLET_PER_MINUTE_V1} times a minute for one wallet, because each price asks two routers. Nothing was prepared; try again in a minute.`
      : 'Miorail is pricing many sends at once just now, and keeps one budget for all of them. Nothing was prepared; try again in a minute.');
    this.name = 'SendValuationBusyErrorV1';
  }
}

/** The two budgets; swappable, so a test does not depend on what the tests before it spent. */
export const sendValuationBudgetV1 = {
  wallet: new InMemoryRateLimiter({ windowMs: 60_000, max: SEND_VALUATIONS_PER_WALLET_PER_MINUTE_V1 }),
  server: new InMemoryRateLimiter({ windowMs: 60_000, max: SEND_VALUATIONS_PER_MINUTE_V1 }),
  reset(): void {
    this.wallet = new InMemoryRateLimiter({ windowMs: 60_000, max: SEND_VALUATIONS_PER_WALLET_PER_MINUTE_V1 });
    this.server = new InMemoryRateLimiter({ windowMs: 60_000, max: SEND_VALUATIONS_PER_MINUTE_V1 });
  },
};

/** One price's place in both budgets, taken before any router is asked; throws when either is spent. */
export async function reserveSendValuationV1(walletAddress: string): Promise<void> {
  if (!(await sendValuationBudgetV1.wallet.consume(`send-value:${walletAddress.toLowerCase()}`)).success) {
    throw new SendValuationBusyErrorV1('wallet');
  }
  if (!(await sendValuationBudgetV1.server.consume('send-value')).success) throw new SendValuationBusyErrorV1('server');
}
