// Recaptures fixtures/burn-address.json: the batches a real read of the public burn address makes,
// answered at the fixture's pinned block, so replay.test.ts runs the whole path on real bytes.
// Every call the fixture already holds must answer byte for byte as recorded; the script says
// which calls are new and stops, writing nothing, if an old one answers differently.
//
// It needs an archive node, because the pinned block is weeks old. The URL is never printed:
//   STILL_CAPTURE_RPC_URL=… node --import tsx test/capture.ts
//
// Not a test (no .test.ts): `pnpm test` never runs it.

import { readFileSync, writeFileSync } from 'node:fs';
import type { Address, PublicClient } from 'viem';
import { loadUniverse, readWallet } from '../src/read.js';
import { createProviders, type Provider } from '../src/rpc.js';
import type { RecordedBatch, RecordedCall } from './replay.js';

const path = new URL('./fixtures/burn-address.json', import.meta.url);
const fixture = JSON.parse(readFileSync(path, 'utf8')) as { address: Address; capturedAt: string; block: string; batches: RecordedBatch[] };
const url = process.env.STILL_CAPTURE_RPC_URL;
if (!url) throw new Error('STILL_CAPTURE_RPC_URL is not set');
const pinned = BigInt(fixture.block);
const [node] = createProviders([url], 'still-capture/0.1');
if (!node) throw new Error('no provider');

type Read = { args: [RecordedCall[]]; blockNumber?: bigint; blockTag?: string };
const batches: RecordedBatch[] = [];
// What the engine reads at "latest" is answered at the pinned block and recorded unpinned, the
// way the first capture recorded it on the day.
const provider: Provider = {
  label: 'capture',
  client: {
    readContract: async (params: Read) => {
      const { blockTag: _latest, ...rest } = params;
      const results = (await node.client.readContract({ ...rest, blockNumber: params.blockNumber ?? pinned } as never)) as RecordedBatch['results'];
      batches.push({
        blockNumber: params.blockNumber === undefined ? null : params.blockNumber.toString(),
        calls: params.args[0].map((c) => ({ target: c.target, callData: c.callData })),
        results: results.map((r) => ({ success: r.success, returnData: r.returnData })),
      });
      return results;
    },
  } as unknown as PublicClient,
};

const universe = await loadUniverse([provider]);
const snapshot = await readWallet([provider], universe, fixture.address);
if (snapshot.block.number !== pinned) throw new Error(`answered at block ${snapshot.block.number}, not ${pinned}`);

const key = (c: RecordedCall) => `${c.target.toLowerCase()}:${c.callData}`;
const before = new Map<string, { success: boolean; returnData: string }>();
for (const b of fixture.batches) b.calls.forEach((c, i) => before.set(key(c), b.results[i]!));
let same = 0;
const changed: string[] = [];
const added: string[] = [];
for (const b of batches) {
  b.calls.forEach((c, i) => {
    const was = before.get(key(c));
    const now = b.results[i]!;
    const name = `${c.target.slice(0, 6)}…${c.target.slice(-4)} ${c.callData.slice(0, 10)}`;
    if (!was) added.push(`${name} -> ${now.success ? 'answered' : 'reverted'}`);
    else if (was.success === now.success && was.returnData === now.returnData) same += 1;
    else changed.push(name);
  });
}
console.log(`${batches.length} batches, ${batches.reduce((n, b) => n + b.calls.length, 0)} calls: ${same} as recorded, ${changed.length} different, ${added.length} new`);
for (const line of added) console.log(`  new ${line}`);
if (changed.length > 0) {
  for (const line of changed) console.log(`  DIFFERENT ${line}`);
  throw new Error('an old call answered differently at the pinned block; nothing written');
}
writeFileSync(path, `${JSON.stringify({ ...fixture, batches }, null, 1)}\n`);
console.log('written');
