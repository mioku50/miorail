/**
 * The operator's side of a Loop draw's prizes: who won, and recording them sent.
 *
 *   pnpm still:loop-draw-prize 2026-11-28                  the draw, its winning entries and their wallets, masked
 *   pnpm still:loop-draw-prize 2026-11-28 --reveal         the winners' whole addresses, to send the prizes to
 *   pnpm still:loop-draw-prize 2026-11-28 --paid 0x<hash> --from 0x<prize wallet>
 *                                                          records as sent each winner, not yet recorded, whom Base
 *                                                          shows that transaction paying at least the prize in USDC
 *                                                          from the prize wallet (one batch may pay them all)
 *
 * A receipt proves a prize only when (audit LOOP-3, 2026-11-18):
 *   - its USDC came from the wallet named by --from, the one the prizes are sent from;
 *   - it landed after the block that picked the winners, so no earlier transfer can stand for a prize;
 *   - each USDC transfer in it pays one prize only: a transfer already recorded for a prize, in this draw or in
 *     another, is not counted again, so one 5 USDC transfer cannot be two prizes.
 *
 * Reads the database and, for --paid, one receipt from Base. With --paid it
 * appends to that one draw's payouts and writes nothing else. It signs and
 * sends nothing: the operator sends the prizes from their own wallet.
 */
import { client, closeDb, withDatabaseTransaction } from '@mioagent/db';
import { createDatabaseStillLoopDrawRepositoryV1, type SqlTemplateExecutor } from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import { loopPrizeTransfersV1, recordLoopPrizesV1 } from './stillLoopDrawPrize.js';

const args = process.argv.slice(2);
const drawId = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
const reveal = args.includes('--reveal');
const valueOf = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? '').toLowerCase() : null;
};
const paidTx = valueOf('--paid');
const sender = valueOf('--from');
const mask = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

/** What one transaction's receipt says, by Base itself: its block, and the USDC it moved from `from` to each
 * wallet. Null when it failed or is not there. */
async function usdcSentBy(tx: string, from: string): Promise<{ block: bigint; sent: Map<string, bigint> } | null> {
  const rpc = process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] }) });
  const body = await response.json() as { result?: { status: string; blockNumber: string; logs: Array<{ address: string; topics: string[]; data: string }> } | null };
  const receipt = body.result;
  if (!receipt || receipt.status !== '0x1' || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)) return null;
  return { block: BigInt(receipt.blockNumber), sent: loopPrizeTransfersV1(receipt.logs, from) };
}

async function main(): Promise<number> {
  if (!drawId || (paidTx !== null && (!/^0x[0-9a-f]{64}$/.test(paidTx) || sender === null || !/^0x[0-9a-f]{40}$/.test(sender)))) {
    console.error('Usage: pnpm still:loop-draw-prize <draw id, as 2026-11-28> [--reveal] [--paid 0x<transaction hash> --from 0x<the wallet the prizes are sent from>]');
    return 2;
  }
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const repository = createDatabaseStillLoopDrawRepositoryV1(client as unknown as SqlTemplateExecutor);
  const record = await repository.byId(drawId);
  if (!record) {
    console.log(`${drawId}: its list is not fixed yet (30 seconds after the close).`);
    return 1;
  }
  console.log(`${drawId}: ${record.entryCount} entries, list ${record.entriesHash}, fixed ${record.lockedAt}`);
  if (record.drawnAt === null) {
    console.log('not drawn yet: the block is read a minute after it is due.');
    return 1;
  }
  if (record.winnerNos === null) {
    console.log('nobody entered, so there is no prize to send.');
    return 0;
  }
  const prize = BigInt(record.prizeAtomic);
  console.log(`block ${record.blockNumber} ${record.blockHash}`);
  console.log(`prize: ${prize / 1_000_000n} USDC on Base to each of ${record.winnerNos.length} winner(s)`);
  for (const no of record.winnerNos) {
    const winner = record.entries[no - 1]!;
    const payout = record.payouts.find((row) => row.no === no);
    console.log(`  entry ${no}, ${winner.label} (${winner.kind}), wallet ${reveal ? winner.walletAddress : mask(winner.walletAddress)}: `
      + (payout ? `recorded sent ${payout.at} in ${payout.tx}` : 'not recorded sent yet'));
  }
  if (paidTx === null) return 0;
  const unpaid = record.winnerNos.filter((no) => !record.payouts.some((row) => row.no === no));
  if (unpaid.length === 0) {
    console.log('every winner is already recorded: nothing written.');
    return 0;
  }
  const receipt = await usdcSentBy(paidTx, sender!);
  if (receipt === null) {
    console.log(`Base shows no successful receipt for ${paidTx}: nothing written.`);
    return 1;
  }
  if (record.blockNumber === null || receipt.block <= BigInt(record.blockNumber)) {
    console.log(`${paidTx} landed in block ${receipt.block}, not after block ${record.blockNumber}, which picked the winners: nothing written.`);
    return 1;
  }
  // What this transaction already paid, in any draw: each of its transfers is one prize at most. Read and written
  // in one locked transaction, so two runs at once cannot count the same transfer twice (audit, 2026-11-18).
  const written = await recordLoopPrizesV1({ transaction: withDatabaseTransaction, drawId, paidTx, sent: receipt.sent, prize, at: new Date() });
  if (written.covered.length === 0) {
    console.log(`${paidTx} sends no unrecorded winner at least ${prize / 1_000_000n} USDC from ${mask(sender!)} that no recorded prize already counts: nothing written.`);
    return 1;
  }
  for (const no of written.covered) {
    console.log(written.recorded.includes(no) ? `recorded: entry ${no} paid in ${paidTx}.` : `entry ${no}: not recorded.`);
  }
  return 0;
}

main().then(async (code) => {
  await closeDb();
  process.exitCode = code;
}, async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb().catch(() => undefined);
  process.exitCode = 2;
});
