/**
 * The operator's side of a Loop draw's prizes: who won, and recording them sent.
 *
 *   pnpm still:loop-draw-prize 2026-11-28                  the draw, its winning entries and their wallets, masked
 *   pnpm still:loop-draw-prize 2026-11-28 --reveal         the winners' whole addresses, to send the prizes to
 *   pnpm still:loop-draw-prize 2026-11-28 --paid 0x<hash>  records as sent each winner, not yet recorded, whom Base
 *                                                          shows that transaction paying at least the prize in USDC
 *                                                          (one batch may pay them all)
 *
 * Reads the database and, for --paid, one receipt from Base. With --paid it
 * appends to that one draw's payouts and writes nothing else. It signs and
 * sends nothing: the operator sends the prizes from their own wallet.
 */
import { client, closeDb } from '@mioagent/db';
import { createDatabaseStillLoopDrawRepositoryV1, type SqlTemplateExecutor } from '@mioagent/route-storage';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const USDC_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const args = process.argv.slice(2);
const drawId = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
const reveal = args.includes('--reveal');
const paidAt = args.indexOf('--paid');
const paidTx = paidAt >= 0 ? (args[paidAt + 1] ?? '').toLowerCase() : null;
const mask = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

/** How much USDC the transaction moved to each wallet, by Base's own receipt; null when it failed or is not there. */
async function usdcSentBy(tx: string): Promise<Map<string, bigint> | null> {
  const rpc = process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] }) });
  const body = await response.json() as { result?: { status: string; logs: Array<{ address: string; topics: string[]; data: string }> } | null };
  const receipt = body.result;
  if (!receipt || receipt.status !== '0x1') return null;
  const sent = new Map<string, bigint>();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_V1 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC_V1 || !log.topics[2]) continue;
    const to = `0x${log.topics[2].slice(-40).toLowerCase()}`;
    sent.set(to, (sent.get(to) ?? 0n) + BigInt(log.data));
  }
  return sent;
}

async function main(): Promise<number> {
  if (!drawId || (paidTx !== null && !/^0x[0-9a-f]{64}$/.test(paidTx))) {
    console.error('Usage: pnpm still:loop-draw-prize <draw id, as 2026-11-28> [--reveal] [--paid 0x<transaction hash>]');
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
  const sent = await usdcSentBy(paidTx);
  if (sent === null) {
    console.log(`Base shows no successful receipt for ${paidTx}: nothing written.`);
    return 1;
  }
  const covered = unpaid.filter((no) => (sent.get(record.entries[no - 1]!.walletAddress.toLowerCase()) ?? 0n) >= prize);
  if (covered.length === 0) {
    console.log(`${paidTx} sends no unrecorded winner at least ${prize / 1_000_000n} USDC: nothing written.`);
    return 1;
  }
  const at = new Date();
  for (const no of covered) {
    const paid = await repository.paid({ drawId, no, paidTx, at });
    console.log(paid?.payouts.some((row) => row.no === no && row.tx === paidTx) ? `recorded: entry ${no} paid in ${paidTx}.` : `entry ${no}: not recorded.`);
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
