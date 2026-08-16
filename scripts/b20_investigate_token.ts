/**
 * Read-only investigation of a single address against the B20 factory.
 *
 * Answers, for one token and with evidence rather than inference:
 *   - does the factory confirm it as a B20 token;
 *   - where is its B20Created event, if it has one;
 *   - is that block inside or outside the range Discover has scanned.
 *
 * Written for the 2026-08-16 MIO report, where "not in the Discover index" was
 * being reported to users as "not a B20 token". Those are different claims and
 * this script is what tells them apart.
 *
 * Reads only. No signer, no key, no write of any kind — the RPC URL is read
 * from the environment and never printed.
 *
 *   pnpm b20:investigate <tokenAddress> [--rpc <url>] [--from <block>] [--to <block>]
 */
import {
  B20_CREATED_TOPIC_V1,
  B20_FACTORY_V1,
  B20_SELECTORS_V1,
  decodeB20CreatedV1,
  type RawLogV1,
} from '@mioagent/b20-control';

const DEFAULT_RPC = 'https://mainnet.base.org';
// base.org answers a 10k-block eth_getLogs in one call; the production Alchemy
// endpoint caps at 10. The window is a parameter so the caller can match
// whichever endpoint they pass.
const DEFAULT_WINDOW = 10_000;

interface Args {
  token: string;
  rpc: string;
  fromBlock: bigint | null;
  toBlock: bigint | null;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let rpc = process.env.B20_INVESTIGATE_RPC_URL ?? process.env.BASE_MAINNET_RPC_URL ?? DEFAULT_RPC;
  let fromBlock: bigint | null = null;
  let toBlock: bigint | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rpc') { rpc = argv[++i] ?? rpc; continue; }
    if (arg === '--from') { fromBlock = BigInt(argv[++i] ?? '0'); continue; }
    if (arg === '--to') { toBlock = BigInt(argv[++i] ?? '0'); continue; }
    positional.push(arg);
  }
  const token = (positional[0] ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error('Usage: pnpm b20:investigate <tokenAddress> [--rpc url] [--from block] [--to block]');
  }
  return { token, rpc, fromBlock, toBlock };
}

let rpcId = 0;
async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'rpc error'}`);
  return body.result;
}

function addressArg(selector: string, address: string): string {
  return `0x${selector}${'0'.repeat(24)}${address.replace(/^0x/, '').toLowerCase()}`;
}

function decodeBool(raw: unknown): boolean | null {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) return null;
  const body = raw.slice(2);
  if (body.length !== 64) return null;
  const value = BigInt(`0x${body}`);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
}

function tokenTopic(token: string): string {
  return `0x${'0'.repeat(24)}${token.replace(/^0x/, '').toLowerCase()}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = (label: string, value: string) => console.log(`${label.padEnd(28)} ${value}`);

  console.log(`\n=== B20 investigation: ${args.token} ===\n`);

  const head = BigInt((await rpcCall(args.rpc, 'eth_blockNumber', [])) as string);
  out('chain head', head.toString());

  // ---- 1. factory identity ------------------------------------------------
  console.log('\n--- factory identity (isB20 / isB20Initialized) ---');
  let isB20: boolean | null = null;
  let isInitialized: boolean | null = null;
  try {
    isB20 = decodeBool(await rpcCall(args.rpc, 'eth_call', [
      { to: B20_FACTORY_V1, data: addressArg(B20_SELECTORS_V1.isB20, args.token) },
      'latest',
    ]));
    isInitialized = decodeBool(await rpcCall(args.rpc, 'eth_call', [
      { to: B20_FACTORY_V1, data: addressArg(B20_SELECTORS_V1.isB20Initialized, args.token) },
      'latest',
    ]));
  } catch (error) {
    out('identity read', `FAILED: ${(error as Error).message}`);
  }
  out('factory', B20_FACTORY_V1);
  out('isB20', isB20 === null ? 'unreadable' : String(isB20));
  out('isB20Initialized', isInitialized === null ? 'unreadable' : String(isInitialized));

  // ---- 2. the launch event ------------------------------------------------
  // The token is topic[1], so this filter is exact: any log it returns is this
  // token's own creation, and an empty result over a covered range is real
  // absence rather than a decode that quietly dropped it.
  console.log('\n--- B20Created event (token is an indexed topic) ---');
  const from = args.fromBlock ?? 0n;
  const to = args.toBlock ?? head;
  out('search range', `${from} .. ${to}`);

  let found: RawLogV1 | null = null;
  let scanned = 0n;
  let windowSize = BigInt(DEFAULT_WINDOW);
  for (let start = to; start >= from && !found; start -= windowSize) {
    const end = start;
    const begin = start - windowSize + 1n > from ? start - windowSize + 1n : from;
    let logs: unknown;
    try {
      logs = await rpcCall(args.rpc, 'eth_getLogs', [{
        address: B20_FACTORY_V1,
        topics: [B20_CREATED_TOPIC_V1, tokenTopic(args.token)],
        fromBlock: `0x${begin.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
      }]);
    } catch (error) {
      // A range the endpoint refuses is not an absent launch. Narrow and retry
      // rather than recording a gap that was never actually read.
      if (windowSize > 10n) { windowSize /= 10n; start += windowSize; continue; }
      throw error;
    }
    scanned += end - begin + 1n;
    const list = Array.isArray(logs) ? (logs as RawLogV1[]) : [];
    if (list.length > 0) found = list[0]!;
    if (begin === from) break;
  }

  out('blocks scanned', scanned.toString());
  if (!found) {
    out('B20Created', 'not found in the scanned range');
  } else {
    const decoded = decodeB20CreatedV1(found);
    if (!decoded.ok) {
      out('B20Created', `found but refused by the decoder: ${decoded.refusal}`);
    } else {
      const launch = decoded.launch;
      out('B20Created block', launch.blockNumber);
      out('  transaction', launch.transactionHash);
      out('  logIndex', String(launch.logIndex));
      out('  symbol / name', `${launch.symbol} / ${launch.name}`);
      out('  variant', launch.variant);
      out('  decimals', String(launch.decimals));
      out('  blockTimestamp', launch.blockTimestamp ?? '(not offered by endpoint)');
    }
  }

  // ---- 3. is that inside what Discover scanned? ---------------------------
  const startBlock = process.env.B20_DISCOVER_START_BLOCK;
  if (startBlock && found) {
    const decoded = decodeB20CreatedV1(found);
    if (decoded.ok) {
      const launchBlock = BigInt(decoded.launch.blockNumber);
      const discoverStart = BigInt(startBlock);
      console.log('\n--- coverage ---');
      out('B20_DISCOVER_START_BLOCK', discoverStart.toString());
      out('launch block', launchBlock.toString());
      out(
        'verdict',
        launchBlock < discoverStart
          ? `BEFORE the scan start by ${discoverStart - launchBlock} blocks — never ingested`
          : 'inside the scanned range — absence has another cause',
      );
    }
  }
  console.log('');
}

void main().catch((error) => {
  console.error(`investigation failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
