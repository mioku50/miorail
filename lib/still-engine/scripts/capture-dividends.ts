// Capture only public issuer data: no wallet is queried and Transfer logs are never requested.
//   node --env-file=.env --import tsx lib/still-engine/scripts/capture-dividends.ts
import { readFile, writeFile } from 'node:fs/promises';
import type { PublicClient } from 'viem';
import { createDividendCalendar } from '../src/dividend-calendar.js';
import { createDividendSource } from '../src/dividends.js';
import { createProviders } from '../src/rpc.js';

const dir = '/tmp/still-dividend-cache';
let cache: unknown = { version: 1, entries: [] };
try {
  cache = JSON.parse(await readFile(`${dir}/dividend-receipts-v1.json`, 'utf8'));
} catch {
  /* A first capture discovers history. */
}
const records: unknown[] = [];
const calendarAnswers: unknown[] = [];
const capturedAt = new Date();
const providers = createProviders([process.env.STILL_RPC_URL, process.env.STILL_RPC_FALLBACK_URL].filter((s): s is string => !!s));
if (!providers.length) throw new Error('STILL_RPC_URL is required');
const recorded = providers.map((provider) => ({
  label: provider.label,
  client: new Proxy(provider.client, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (!['readContract', 'getBlock', 'getLogs'].includes(String(key)) || typeof value !== 'function') return value;
      return async (args: Record<string, unknown>) => {
        const request =
          key === 'readContract'
            ? { args: args.args, blockNumber: args.blockNumber ?? null }
            : key === 'getLogs'
              ? { address: args.address, fromBlock: args.fromBlock, toBlock: args.toBlock }
              : args;
        try {
          const answer = await value(args);
          const result = key === 'getBlock' ? { number: answer.number, timestamp: answer.timestamp, hash: answer.hash } : answer;
          records.push({ method: key, request, result });
          return answer;
        } catch (error) {
          records.push({ method: key, request, failed: true });
          throw error;
        }
      };
    },
  }) as PublicClient,
}));
const calendar = createDividendCalendar({
  now: () => capturedAt,
  fetch: async (...args) => {
    const response = await fetch(...args);
    const body = await response.text();
    calendarAnswers.push(JSON.parse(body));
    return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
  },
});
const report = await createDividendSource({
  providers: recorded,
  calendar,
  dataDir: dir,
  now: () => capturedAt,
  historyBudgetMs: 25_000,
}).current();
await writeFile(
  new URL('../test/fixtures/dividends-base.json', import.meta.url),
  JSON.stringify(
    { capturedAt: capturedAt.toISOString(), cache, records, calendarAnswers, expected: report },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    1,
  ) + '\n',
);
console.log(
  `Captured ${records.length} public RPC reads and ${calendarAnswers.length} calendar pages; ${report.coverage.receiptsVerified} receipts verified, ${report.coverage.receiptsPriced} valued.`,
);
