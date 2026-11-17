/**
 * Checks a Still Loop draw from what anybody can read: the list Still
 * published, and Base itself. It trusts neither Still's block nor its winner:
 *
 *   1. the list's hash is keccak256 of {drawId, closesAt, labels}, as published;
 *   2. the block is the first Base block whose timestamp is at least five
 *      minutes after the later of the close and the moment the list was fixed
 *      (the block before it is earlier), and Base gives it the published hash;
 *   3. the first winner is entry keccak256(blockHash ‖ drawId) mod N + 1, and
 *      each next one, the k-th, keccak256(blockHash ‖ drawId/k) mod (entries
 *      left), counted along the entries not yet picked.
 *
 *   pnpm still:verify-loop-draw 2026-11-28
 *   pnpm still:verify-loop-draw 2026-11-28 --api https://miorail.xyz --rpc https://mainnet.base.org
 *
 * Reads only: no key, no wallet, no signature. Exit 0 when every check holds.
 */
import {
  loopDrawListHashV1,
  loopDrawTargetSecondsV1,
  loopDrawWinnersV1,
} from '../lib/still-engine/src/loopDraws.js';

interface PublishedListV1 {
  drawId: string;
  closesAt: string;
  lockedAt: string;
  entriesHash: string;
  labels: string[];
  blockAt: string | null;
  block: { number: string; hash: string; time: string } | null;
  winnerCount: number;
  winnerNos: number[] | null;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
};
const drawId = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
const api = option('--api', 'https://miorail.xyz').replace(/\/+$/, '');
const rpc = option('--rpc', 'https://mainnet.base.org');

async function blockOf(number: bigint): Promise<{ number: bigint; hash: string; timestamp: bigint }> {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [`0x${number.toString(16)}`, false] }),
  });
  const body = await response.json() as { result?: { number: string; hash: string; timestamp: string } | null };
  if (!body.result) throw new Error(`Base block ${number} could not be read from ${new URL(rpc).host}`);
  return { number: BigInt(body.result.number), hash: body.result.hash.toLowerCase(), timestamp: BigInt(body.result.timestamp) };
}

async function main(): Promise<number> {
  if (!drawId) {
    console.error('Usage: pnpm still:verify-loop-draw <draw id, as 2026-11-28> [--api URL] [--rpc URL]');
    return 2;
  }
  const response = await fetch(`${api}/api/public/still/loops/draws/${drawId}`);
  if (!response.ok) {
    console.error(`The list of ${drawId} is not published (${response.status}). A list is fixed 30 seconds after its draw closes.`);
    return 2;
  }
  const list = await response.json() as PublishedListV1;
  let failed = 0;
  const check = (ok: boolean, words: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${words}`);
    if (!ok) failed += 1;
  };

  const hash = loopDrawListHashV1({ drawId, closesAt: list.closesAt, labels: list.labels });
  check(hash === list.entriesHash, `the list of ${list.labels.length} hashes to ${hash}`);
  if (list.labels.length === 0) {
    check(list.winnerNos === null && list.block === null, 'nobody entered, and nobody won');
    return failed === 0 ? 0 : 1;
  }
  const target = loopDrawTargetSecondsV1({ closesAt: list.closesAt, lockedAt: list.lockedAt });
  const due = new Date(Number(target) * 1000).toISOString();
  console.log(`     fixed at ${list.lockedAt}; the picking block is the first at or after ${due}`);
  if (list.blockAt !== null) check(list.blockAt === due, `the published time the block is due is ${due}`);
  if (!list.block) {
    console.log('     not drawn yet: the block is read a minute after it is due');
    return failed === 0 ? 0 : 1;
  }
  const block = await blockOf(BigInt(list.block.number));
  const parent = await blockOf(block.number - 1n);
  check(block.hash === list.block.hash.toLowerCase(), `Base gives block ${block.number} the published hash ${block.hash}`);
  check(block.timestamp >= target, `block ${block.number} is at ${new Date(Number(block.timestamp) * 1000).toISOString()}, at or after the time due`);
  check(parent.timestamp < target, `block ${parent.number}, the one before it, is earlier: it is the first`);
  const winners = loopDrawWinnersV1({ blockHash: block.hash as `0x${string}`, drawId, count: list.labels.length, winners: list.winnerCount });
  check(JSON.stringify(winners) === JSON.stringify(list.winnerNos),
    `${winners.length === 1 ? 'the winner is' : `the ${winners.length} winners are`}: ${winners.map((no) => `entry ${no}, ${list.labels[no - 1]}`).join('; ')}`);
  console.log(failed === 0 ? `\n${drawId}: every check holds.` : `\n${drawId}: ${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
