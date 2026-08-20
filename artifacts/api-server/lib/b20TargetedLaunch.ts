import {
  B20_CREATED_TOPIC_V1,
  B20_FACTORY_V1,
  type RawLogV1,
} from '@mioagent/b20-control';

// ---------------------------------------------------------------------------
// Find the ONE creation event for a factory-confirmed B20 token.
//
// An exact topic filter still cannot make an archive provider accept a
// million-block `eth_getLogs` range. The token contract itself gives us a
// bounded index: code is absent before creation and present afterwards, so a
// binary search finds the first code block in ~26 read-only calls on Base.
// One single-block log read then obtains the canonical B20Created evidence.
//
// No signer, no wallet and no write method exists in this module. It returns
// the raw public log; the caller must pass it through the SAME decoder and
// immutable launch repository as the Discover worker.
// ---------------------------------------------------------------------------

export type B20TargetedLaunchLookupV1 =
  | { outcome: 'found'; headBlock: number; creationBlock: number; log: RawLogV1; calls: number }
  | { outcome: 'not_found'; calls: number }
  | { outcome: 'provider_unavailable'; calls: number }
  | { outcome: 'timed_out'; calls: number };

export interface B20TargetedLaunchLookupInputV1 {
  rpcUrl: string;
  tokenAddress: string;
  budgetMs: number;
  fetchImpl?: typeof fetch;
  monotonicMs?: () => number;
}

function tokenTopicV1(tokenAddress: string): string {
  return `0x${'0'.repeat(24)}${tokenAddress.slice(2).toLowerCase()}`;
}

function rawLogV1(value: unknown): RawLogV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const log = value as Record<string, unknown>;
  if (
    typeof log.address !== 'string' ||
    !Array.isArray(log.topics) ||
    log.topics.some((topic) => typeof topic !== 'string') ||
    typeof log.data !== 'string'
  ) return null;
  return {
    address: log.address,
    topics: log.topics as string[],
    data: log.data,
    blockNumber: typeof log.blockNumber === 'string' ? log.blockNumber : null,
    blockHash: typeof log.blockHash === 'string' ? log.blockHash : null,
    transactionHash: typeof log.transactionHash === 'string' ? log.transactionHash : null,
    logIndex: typeof log.logIndex === 'string' ? log.logIndex : null,
    transactionIndex: typeof log.transactionIndex === 'string' ? log.transactionIndex : null,
    blockTimestamp: typeof log.blockTimestamp === 'string' ? log.blockTimestamp : null,
    removed: log.removed === true,
  };
}

export async function locateB20LaunchByCodeV1(
  input: B20TargetedLaunchLookupInputV1,
): Promise<B20TargetedLaunchLookupV1> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const monotonicMs = input.monotonicMs ?? (() => Date.now());
  const startedAt = monotonicMs();
  const deadline = startedAt + Math.max(1, input.budgetMs);
  let nextId = 1;
  let calls = 0;

  const rpc = async (method: string, params: unknown[]): Promise<
    | { ok: true; value: unknown }
    | { ok: false; reason: 'provider_unavailable' | 'timed_out' }
  > => {
    const remaining = deadline - monotonicMs();
    if (remaining <= 0) return { ok: false, reason: 'timed_out' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, 3_000));
    calls += 1;
    try {
      const response = await fetchImpl(input.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: 'provider_unavailable' };
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      if (body.error || body.result === undefined) return { ok: false, reason: 'provider_unavailable' };
      return { ok: true, value: body.result };
    } catch {
      return { ok: false, reason: monotonicMs() >= deadline ? 'timed_out' : 'provider_unavailable' };
    } finally {
      clearTimeout(timer);
    }
  };

  const headResult = await rpc('eth_blockNumber', []);
  if (!headResult.ok) return { outcome: headResult.reason, calls };
  let head: number;
  try {
    head = Number(BigInt(String(headResult.value)));
  } catch {
    return { outcome: 'provider_unavailable', calls };
  }
  if (!Number.isSafeInteger(head) || head < 0) return { outcome: 'provider_unavailable', calls };

  const codeAt = async (block: number) => {
    const result = await rpc('eth_getCode', [input.tokenAddress, `0x${block.toString(16)}`]);
    if (!result.ok) return result;
    if (typeof result.value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result.value)) {
      return { ok: false as const, reason: 'provider_unavailable' as const };
    }
    return { ok: true as const, value: result.value !== '0x' && !/^0x0*$/.test(result.value) };
  };

  const atHead = await codeAt(head);
  if (!atHead.ok) return { outcome: atHead.reason, calls };
  if (!atHead.value) return { outcome: 'not_found', calls };

  let low = 0;
  let high = head;
  while (low < high) {
    if (monotonicMs() >= deadline) return { outcome: 'timed_out', calls };
    const middle = Math.floor((low + high) / 2);
    const code = await codeAt(middle);
    if (!code.ok) return { outcome: code.reason, calls };
    if (code.value) high = middle;
    else low = middle + 1;
  }

  const blockHex = `0x${low.toString(16)}`;
  const logsResult = await rpc('eth_getLogs', [
    {
      address: B20_FACTORY_V1,
      topics: [B20_CREATED_TOPIC_V1, tokenTopicV1(input.tokenAddress)],
      fromBlock: blockHex,
      toBlock: blockHex,
    },
  ]);
  if (!logsResult.ok) return { outcome: logsResult.reason, calls };
  if (!Array.isArray(logsResult.value)) return { outcome: 'provider_unavailable', calls };
  const logs = logsResult.value.map(rawLogV1);
  if (logs.some((log) => log === null)) return { outcome: 'provider_unavailable', calls };
  const log = logs.find(
    (entry) =>
      entry?.address.toLowerCase() === B20_FACTORY_V1 &&
      entry.topics[0]?.toLowerCase() === B20_CREATED_TOPIC_V1.toLowerCase() &&
      entry.topics[1]?.toLowerCase() === tokenTopicV1(input.tokenAddress),
  );
  if (!log || log.removed) return { outcome: 'not_found', calls };
  return { outcome: 'found', headBlock: head, creationBlock: low, log, calls };
}
