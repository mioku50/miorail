// Record the Multicall3 batches a real read makes, and replay them without a network, so the
// whole path from raw bytes to report runs in tests on production-shaped answers.

import type { PublicClient } from 'viem';
import type { Provider } from '../src/rpc.js';

export interface RecordedCall {
  target: string;
  callData: string;
}

export interface RecordedBatch {
  blockNumber: string | null;
  calls: RecordedCall[];
  results: Array<{ success: boolean; returnData: string }>;
}

type ReadArgs = { args: [RecordedCall[]]; blockNumber?: bigint };

export function recording(provider: Provider, into: RecordedBatch[]): Provider {
  const client = provider.client;
  return {
    label: provider.label,
    client: {
      readContract: async (params: ReadArgs) => {
        const results = (await client.readContract(params as never)) as RecordedBatch['results'];
        into.push({
          blockNumber: params.blockNumber === undefined ? null : params.blockNumber.toString(),
          calls: params.args[0].map((c) => ({ target: c.target, callData: c.callData })),
          results: results.map((r) => ({ success: r.success, returnData: r.returnData })),
        });
        return results;
      },
    } as unknown as PublicClient,
  };
}

export function replaying(batches: readonly RecordedBatch[], label = 'replay'): Provider {
  const key = (calls: RecordedCall[]) => calls.map((c) => `${c.target.toLowerCase()}:${c.callData}`).join('|');
  const byCalls = new Map(batches.map((b) => [key(b.calls), b]));
  return {
    label,
    client: {
      readContract: async ({ args }: ReadArgs) => {
        const batch = byCalls.get(key(args[0]));
        if (!batch) throw new Error('replay: this batch was not recorded; capture the fixture again');
        return batch.results;
      },
    } as unknown as PublicClient,
  };
}
