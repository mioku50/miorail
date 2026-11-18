/**
 * Checks a Still Loop draw from what anybody can read: the list Still
 * published, and Base itself. It trusts neither Still's block nor its winner:
 *
 *   1. the list's hash is keccak256 of {drawId, closesAt, lockedAt, winners, labels}, as published: the moment
 *      the list was fixed and the number of winners decide the result, so they are inside what is stamped;
 *   2. each public authority's RFC 3161 time-stamp is of the SHA-256 of that
 *      same text, granted, and signed before the picking block: the list
 *      existed before anybody could know the block's hash. With openssl on
 *      the machine its signature is checked too, against the system's roots;
 *   3. the block is the first Base block whose timestamp is at least five
 *      minutes after the later of the close and the moment the list was fixed
 *      (the block before it is earlier), and Base gives it the published hash;
 *   4. the first winner is entry keccak256(blockHash ‖ drawId) mod N + 1, and
 *      each next one, the k-th, keccak256(blockHash ‖ drawId/k) mod (entries
 *      left), counted along the entries not yet picked.
 *
 *   pnpm still:verify-loop-draw 2026-11-28
 *   pnpm still:verify-loop-draw 2026-11-28 --api https://miorail.xyz --rpc https://mainnet.base.org
 *
 * Reads only: no key, no wallet, no signature of its own. Exit 0 when every check holds and at least one
 * authority's stamp, signature included, proves the list existed before the block was due; exit 3 when every
 * check that ran holds but that time is not proven (no stamp, or openssl could not check one); exit 1 when a
 * check fails (audit, 2026-11-18: a missing stamp or an unchecked signature used to exit 0).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loopDrawListHashV1,
  loopDrawListTextV1,
  loopDrawTargetSecondsV1,
  loopDrawWinnersV1,
} from '../lib/still-engine/src/loopDraws.js';
import { rfc3161ResponseV1, rfc3161StampsV1 } from '../lib/still-engine/src/rfc3161.js';

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
  stamps?: { tsa: string; genTime: string; token: string }[];
}

const ROOTS_V1 = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];

/** openssl's word on a stamp's signature: true, false, or null when openssl or the system's roots are not here. */
function opensslVerifiesV1(text: string, token: string): boolean | null {
  const roots = ROOTS_V1.find((path) => existsSync(path));
  if (!roots) return null;
  const dir = mkdtempSync(join(tmpdir(), 'loop-draw-'));
  try {
    writeFileSync(join(dir, 'list.txt'), text);
    writeFileSync(join(dir, 'stamp.tsr'), Buffer.from(token, 'base64'));
    const out = execFileSync('openssl', ['ts', '-verify', '-data', join(dir, 'list.txt'), '-in', join(dir, 'stamp.tsr'), '-CAfile', roots],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /Verification: OK/.test(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

  const committed = { drawId, closesAt: list.closesAt, lockedAt: list.lockedAt, winners: list.winnerCount, labels: list.labels };
  const hash = loopDrawListHashV1(committed);
  check(hash === list.entriesHash, `the list of ${list.labels.length}, fixed at ${list.lockedAt} for ${list.winnerCount} winner(s), hashes to ${hash}`);
  if (list.labels.length === 0) {
    check(list.winnerNos === null && list.block === null, 'nobody entered, and nobody won');
    return failed === 0 ? 0 : 1;
  }
  const target = loopDrawTargetSecondsV1({ closesAt: list.closesAt, lockedAt: list.lockedAt });
  const text = loopDrawListTextV1(committed);
  const digest = createHash('sha256').update(text, 'utf8').digest();
  const stamps = list.stamps ?? [];
  // Proven only by a stamp that is of this text, before the block was due, and whose signature openssl checked.
  let timeProven = false;
  if (stamps.length === 0) console.log('     no time-stamp: when the list was fixed rests on Still\u2019s word alone');
  for (const stamp of stamps) {
    const reading = rfc3161ResponseV1(new Uint8Array(Buffer.from(stamp.token, 'base64')));
    const of = rfc3161StampsV1(reading, digest);
    const named = of && reading.genTime === new Date(stamp.genTime).toISOString();
    check(named, `${new URL(stamp.tsa).host} stamped the SHA-256 of this list at ${of ? reading.genTime : 'no readable time'}`);
    const early = of && Date.parse(reading.genTime) < Number(target) * 1000;
    if (of) check(early, `${new URL(stamp.tsa).host}'s stamp is before the picking block was due`);
    const signed = opensslVerifiesV1(text, stamp.token);
    if (signed === null) console.log(`     ${new URL(stamp.tsa).host}'s signature not checked: openssl or the system's roots are not on this machine`);
    else check(signed, `openssl checks ${new URL(stamp.tsa).host}'s signature against the system's roots`);
    if (named && early && signed === true) timeProven = true;
  }
  // What a run that found no fault but could not prove the time ends with: never the 0 of a full proof.
  const verdict = (): number => {
    if (failed > 0) return 1;
    if (!timeProven) {
      console.log(`\n${drawId}: no check failed, but the time the list was fixed is not proven: no authority's stamp was checked in full.`);
      return 3;
    }
    return 0;
  };
  const due = new Date(Number(target) * 1000).toISOString();
  console.log(`     fixed at ${list.lockedAt}; the picking block is the first at or after ${due}`);
  if (list.blockAt !== null) check(list.blockAt === due, `the published time the block is due is ${due}`);
  if (!list.block) {
    console.log('     not drawn yet: the block is read a minute after it is due');
    return verdict();
  }
  const block = await blockOf(BigInt(list.block.number));
  const parent = await blockOf(block.number - 1n);
  check(block.hash === list.block.hash.toLowerCase(), `Base gives block ${block.number} the published hash ${block.hash}`);
  check(block.timestamp >= target, `block ${block.number} is at ${new Date(Number(block.timestamp) * 1000).toISOString()}, at or after the time due`);
  check(parent.timestamp < target, `block ${parent.number}, the one before it, is earlier: it is the first`);
  const winners = loopDrawWinnersV1({ blockHash: block.hash as `0x${string}`, drawId, count: list.labels.length, winners: list.winnerCount });
  check(JSON.stringify(winners) === JSON.stringify(list.winnerNos),
    `${winners.length === 1 ? 'the winner is' : `the ${winners.length} winners are`}: ${winners.map((no) => `entry ${no}, ${list.labels[no - 1]}`).join('; ')}`);
  if (failed > 0) console.log(`\n${drawId}: ${failed} check(s) failed.`);
  else if (timeProven) console.log(`\n${drawId}: every check holds.`);
  return verdict();
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
