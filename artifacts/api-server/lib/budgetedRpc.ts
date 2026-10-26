import {
  chooseRpcEndpointV1,
  cuForBatchV1,
  createB20ReaderV1,
  isEndpointFailureV1,
  type B20BatchCallV1,
  type B20ReaderV1,
  type B20RpcReasonV1,
  type B20RpcResultV1,
} from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import {
  createDatabaseRpcCuLedgerRepository,
  type RpcCuLedgerRepositoryV1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// One reader, two endpoints, and a budget that survives a restart.
//
// Measured on the same hundred-contract sweep: the public endpoint read 8 of
// 100 and Alchemy read 100 of 100, because the public one caps a JSON-RPC batch
// at ten calls and throttles under sustained load. That difference is not a
// preference — it is a surface that answers versus one that renders `unread`
// over our own transport.
//
// So Alchemy is the read path while the month's compute units allow it, and the
// public endpoint is what everything falls back to. The spend is written to
// Postgres because a counter in memory says "under budget" after every deploy
// regardless of the truth.
//
// The fallback is never silently better or worse: it is the SAME questions to a
// slower endpoint, and every call that goes there is counted too, so an
// operator can see how much of the month ran degraded.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Alchemy's refusal outranks our ledger.
//
// The ledger counts what THIS deployment spent, and the Alchemy account is
// shared with other projects. On 2026-10-25 one of them spent the month: every
// call came back HTTP 429 "Monthly capacity limit exceeded" while the ledger
// read 6.9M of 300M CU and kept choosing Alchemy. Nothing fell back, so the
// cash-exit ladder failed every pass and the market-reality reads answered
// `rate_limited`, with a healthy fallback configured the whole time.
//
// So when Alchemy does not answer, the fallback is asked the same question at
// once, and Alchemy stays out of the rotation for every budgeted reader in this
// process for a while. One refused call per window is the whole cost of finding
// out that it is back.
// ---------------------------------------------------------------------------

/** How long one refusal keeps Alchemy out of the rotation. */
export const ALCHEMY_REFUSAL_COOLDOWN_MS_V1 = 10 * 60_000;

let lastAlchemyRefusal: { atMs: number; reason: B20RpcReasonV1 } | null = null;

/** The last time Alchemy did not answer a budgeted read in this process, or
 * null when it has not failed since the process started. For the status route. */
export function lastAlchemyRefusalV1(): { at: string; reason: B20RpcReasonV1 } | null {
  if (!lastAlchemyRefusal) return null;
  return { at: new Date(lastAlchemyRefusal.atMs).toISOString(), reason: lastAlchemyRefusal.reason };
}

/** Reset between tests; never called in production. */
export function resetAlchemyRefusalV1(): void {
  lastAlchemyRefusal = null;
}

export interface BudgetedRpcConfigV1 {
  alchemyUrl: string | null;
  fallbackUrl: string;
  ledger?: RpcCuLedgerRepositoryV1;
  now?: () => Date;
  /** Refreshed from storage no more often than this. A read path may not pay
   * for a ledger query on every batch. */
  refreshMs?: number;
  refusalCooldownMs?: number;
  /** The reader for one endpoint. A seam for tests; production reads through
   * `createB20ReaderV1`. */
  readerFor?: (rpcUrl: string) => B20ReaderV1;
}

export function budgetedRpcConfigFromEnvV1(env: NodeJS.ProcessEnv = process.env): BudgetedRpcConfigV1 | null {
  const fallbackUrl = (env.BASE_MAINNET_RPC_URL || env.BASE_RPC_URL || '').trim();
  if (!fallbackUrl) return null;
  const alchemyUrl = (env.ALCHEMY_BASE_MAINNET_RPC_URL || '').trim();
  return { alchemyUrl: alchemyUrl.length > 0 ? alchemyUrl : null, fallbackUrl };
}

/**
 * A reader that picks its endpoint per batch and pays for what it used.
 *
 * The spend is recorded AFTER the call, whatever the answer: a refused or
 * reverted `eth_call` is metered by the provider all the same, and a budget
 * that only counts successes drifts under the real one.
 */
export function createBudgetedReaderV1(config: BudgetedRpcConfigV1): B20ReaderV1 {
  const ledger = config.ledger ?? createDatabaseRpcCuLedgerRepository(client);
  const now = config.now ?? (() => new Date());
  const refreshMs = config.refreshMs ?? 60_000;
  const cooldownMs = config.refusalCooldownMs ?? ALCHEMY_REFUSAL_COOLDOWN_MS_V1;
  const readerFor = config.readerFor ?? ((rpcUrl: string) => createB20ReaderV1({ rpcUrl }));
  const alchemy = config.alchemyUrl ? readerFor(config.alchemyUrl) : null;
  const fallback = readerFor(config.fallbackUrl);

  let spentCu = 0;
  let refreshedAt = 0;
  const refresh = async (): Promise<void> => {
    const at = Date.now();
    if (at - refreshedAt < refreshMs) return;
    refreshedAt = at;
    try {
      const rows = await ledger.readMonth(now());
      spentCu = rows
        .filter((row) => row.provider === 'alchemy')
        .reduce((total, row) => total + row.spentCu, 0);
    } catch {
      // A ledger that will not read is not a licence to spend: leave the last
      // figure standing rather than resetting to zero.
    }
  };

  const settle = (provider: 'alchemy' | 'fallback', methods: readonly string[]): void => {
    const cu = cuForBatchV1(methods);
    if (provider === 'alchemy') spentCu += cu;
    void ledger.recordSpend({ provider, cu, calls: methods.length, now: now() }).catch(() => {
      // Losing one batch's accounting must not fail the read it accounted for.
    });
  };

  const noteRefusal = (reason: B20RpcReasonV1): void => {
    lastAlchemyRefusal = { atMs: now().getTime(), reason };
  };

  const pick = async (methods: readonly string[]): Promise<B20ReaderV1> => {
    await refresh();
    const alchemyRefusing =
      lastAlchemyRefusal !== null && now().getTime() - lastAlchemyRefusal.atMs < cooldownMs;
    const choice = chooseRpcEndpointV1(
      { spentCu, alchemyConfigured: alchemy !== null, alchemyRefusing },
      methods,
    );
    return choice.provider === 'alchemy' && alchemy ? alchemy : fallback;
  };

  /**
   * One question, asked of the chosen endpoint, and of the fallback at once
   * when Alchemy did not answer it. A revert or an empty result IS an answer
   * and is never asked twice.
   */
  const ask = async <T>(
    methods: readonly string[],
    read: (reader: B20ReaderV1) => Promise<B20RpcResultV1<T>>,
  ): Promise<B20RpcResultV1<T>> => {
    const reader = await pick(methods);
    const answer = await read(reader);
    settle(reader === fallback ? 'fallback' : 'alchemy', methods);
    if (reader === fallback || answer.ok || !isEndpointFailureV1(answer.reason)) return answer;
    noteRefusal(answer.reason);
    const again = await read(fallback);
    settle('fallback', methods);
    return again;
  };

  const callAll = async (reader: B20ReaderV1, inputs: readonly B20BatchCallV1[]) =>
    reader.callMany
      ? reader.callMany(inputs)
      : Promise.all(inputs.map((input) => reader.call(input)));

  return {
    readBlockAnchor() {
      return ask(['eth_blockNumber'], (reader) => reader.readBlockAnchor());
    },
    readIsB20(token, blockTag) {
      return ask(['eth_call'], (reader) => reader.readIsB20(token, blockTag));
    },
    readIsB20Initialized(token, blockTag) {
      return ask(['eth_call'], (reader) => reader.readIsB20Initialized(token, blockTag));
    },
    readVariantActivated(variant, blockTag) {
      return ask(['eth_call'], (reader) => reader.readVariantActivated(variant, blockTag));
    },
    call(input) {
      return ask(['eth_call'], (reader) => reader.call(input));
    },
    async callMany(inputs: readonly B20BatchCallV1[]) {
      const methods = inputs.map(() => 'eth_call');
      const reader = await pick(methods);
      const answers = await callAll(reader, inputs);
      settle(reader === fallback ? 'fallback' : 'alchemy', methods);
      if (reader === fallback) return answers;
      // Only the entries Alchemy did not answer are asked again. Every entry is
      // pinned to one block, so an answer from either endpoint describes the
      // same state, and the answered ones are not paid for twice.
      const unanswered: { index: number; reason: B20RpcReasonV1 }[] = [];
      answers.forEach((answer, index) => {
        if (!answer.ok && isEndpointFailureV1(answer.reason)) unanswered.push({ index, reason: answer.reason });
      });
      if (unanswered.length === 0) return answers;
      noteRefusal(unanswered[0]!.reason);
      const again = await callAll(
        fallback,
        unanswered.map(({ index }) => inputs[index]!),
      );
      settle('fallback', unanswered.map(() => 'eth_call'));
      const merged = [...answers];
      unanswered.forEach(({ index }, at) => {
        merged[index] = again[at]!;
      });
      return merged;
    },
    async readTransaction(hash: string) {
      // Optional on the interface. A reader without it has nothing to bill.
      if (!fallback.readTransaction) return { ok: false as const, reason: 'endpoint_unavailable' as const };
      return ask(['eth_getTransactionByHash'], (reader) => reader.readTransaction!(hash));
    },
  } as B20ReaderV1;
}
