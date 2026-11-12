import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { B20BlockAnchorV1, B20ReaderV1, B20RpcReasonV1, B20RpcResultV1 } from '@mioagent/b20-control';

import {
  BLOCK_ANCHOR_ROUNDS_V1,
  BLOCK_ANCHOR_THROTTLED_EXIT_V1,
  BLOCK_ANCHOR_WAIT_MS_V1,
  anchorPatientlyV1,
  blockAnchorExitCodeV1,
  rpcEndpointsV1,
} from './rwaBlockAnchor.js';

// 2026-11-12: the supply and ratio pass asked one endpoint once for its block anchor, was
// throttled at 02:52 UTC, said "nothing read, nothing stored" and exited 0. Supply is trusted for
// seven hours and the pass ran every six, so from 04:51 UTC every Coinbase stock on the board had
// no price, and no unit had failed.

const ANCHOR: B20BlockAnchorV1 = { blockNumber: '56374564', blockHash: `0x${'ab'.repeat(32)}`, blockTag: '0x35c3524' };
type Answer = B20RpcReasonV1 | 'ok';

/** A reader whose anchor answers what the script says, one answer per time it is asked. */
function reader(script: Answer[]): Pick<B20ReaderV1, 'readBlockAnchor'> & { asked: number } {
  const self = {
    asked: 0,
    async readBlockAnchor(): Promise<B20RpcResultV1<B20BlockAnchorV1>> {
      const answer = script[Math.min(self.asked, script.length - 1)]!;
      self.asked += 1;
      return answer === 'ok' ? { ok: true, value: ANCHOR, raw: '0x' } : { ok: false, reason: answer };
    },
  };
  return self;
}
const waits = () => {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
};

test('one throttled answer costs nothing when another endpoint answers', async () => {
  const [first, second] = [reader(['rate_limited']), reader(['ok'])];
  const clock = waits();
  const anchored = await anchorPatientlyV1([first, second], clock);
  assert.equal(anchored.ok, true);
  if (!anchored.ok) return;
  assert.equal(anchored.reader, second);
  assert.equal(anchored.position, 1);
  assert.deepEqual(anchored.refusals, ['rate_limited']);
  assert.equal(anchored.rounds, 1);
  assert.deepEqual(clock.slept, [], 'nothing is waited for while an endpoint answers');
});

test('with one endpoint, as the pass had, the throttle is waited out and asked again', async () => {
  const only = reader(['rate_limited', 'rate_limited', 'ok']);
  const clock = waits();
  const anchored = await anchorPatientlyV1([only], clock);
  assert.equal(anchored.ok, true);
  assert.equal(anchored.rounds, 3);
  assert.equal(only.asked, 3);
  assert.deepEqual(clock.slept, [BLOCK_ANCHOR_WAIT_MS_V1, BLOCK_ANCHOR_WAIT_MS_V1]);
  assert.deepEqual(anchored.refusals, ['rate_limited', 'rate_limited']);
});

test('every endpoint throttled in every round is a pass that failed, and says so as a throttle', async () => {
  const [first, second] = [reader(['rate_limited']), reader(['rpc_timeout'])];
  const clock = waits();
  const anchored = await anchorPatientlyV1([first, second], clock);
  assert.equal(anchored.ok, false);
  assert.equal(anchored.rounds, BLOCK_ANCHOR_ROUNDS_V1);
  assert.deepEqual([first.asked, second.asked], [BLOCK_ANCHOR_ROUNDS_V1, BLOCK_ANCHOR_ROUNDS_V1]);
  // No wait after the last round: nothing follows it.
  assert.equal(clock.slept.length, BLOCK_ANCHOR_ROUNDS_V1 - 1);
  assert.equal(anchored.refusals.length, 2 * BLOCK_ANCHOR_ROUNDS_V1);
  assert.equal(blockAnchorExitCodeV1(anchored.refusals), BLOCK_ANCHOR_THROTTLED_EXIT_V1);
  assert.equal(BLOCK_ANCHOR_THROTTLED_EXIT_V1, 75, 'the code the service alerts read as a provider rate limiting the pass');
});

test('an answer about the chain is final: it is not asked again, and it is not called a throttle', async () => {
  const [first, second] = [reader(['reverted']), reader(['ok'])];
  const clock = waits();
  const anchored = await anchorPatientlyV1([first, second], clock);
  assert.equal(anchored.ok, false);
  assert.deepEqual([first.asked, second.asked, clock.slept.length], [1, 0, 0]);
  assert.equal(blockAnchorExitCodeV1(anchored.refusals), 1);
  // An endpoint out of its plan refuses however long it is waited for, but another round may find
  // the other endpoint back; it is still not a throttle that clears, so the code is 1.
  assert.equal(blockAnchorExitCodeV1(['rate_limited', 'rpc_error']), 1);
  assert.equal(blockAnchorExitCodeV1([]), 1);
});

test('the endpoints are each asked once, in the order named, and an unset name is none', () => {
  assert.deepEqual(rpcEndpointsV1([' https://a.example ', undefined, 'https://b.example', '', 'https://a.example']), ['https://a.example', 'https://b.example']);
  assert.deepEqual(rpcEndpointsV1([undefined, '  ']), []);
});

test('the supply and ratio pass anchors patiently, fails when it read nothing, and runs twice inside what supply is trusted for', () => {
  const script = readFileSync(new URL('./rwa_read_representation_ratio.ts', import.meta.url), 'utf8');
  assert.match(script, /const anchored = await anchorPatientlyV1\(readers\);/);
  assert.match(script, /process\.exitCode = blockAnchorExitCodeV1\(anchored\.refusals\);/);
  assert.match(script, /withCallFailoverV1\(anchored\.reader, readers\.slice\(anchored\.position \+ 1\)\)/);
  assert.equal(script.includes('reader.readBlockAnchor()'), false, 'never one endpoint asked once');
  const timer = readFileSync(new URL('../ops/systemd/miorail-rwa-ratio.timer', import.meta.url), 'utf8');
  const hours = Number(/^OnUnitActiveSec=(\d+)h$/m.exec(timer)?.[1]);
  const engine = readFileSync(new URL('../lib/rwa-market-reality/src/engine.ts', import.meta.url), 'utf8');
  const trusted = Number(/const SUPPLY_FRESHNESS_TTL_MS_V1 = (\d+) \* 60 \* 60 \* 1_000;/.exec(engine)?.[1]);
  assert.ok(Number.isFinite(hours) && Number.isFinite(trusted), `${hours} ${trusted}`);
  // Two passes, with their ten minutes of jitter and the minutes a pass takes, before a reading lapses.
  assert.ok(2 * hours + 1 <= trusted, `every ${hours} h against ${trusted} h of trust`);
});
