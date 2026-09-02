import {
  chooseRpcEndpointV1,
  cuForBatchV1,
  createB20ReaderV1,
  type B20BatchCallV1,
  type B20ReaderV1,
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

export interface BudgetedRpcConfigV1 {
  alchemyUrl: string | null;
  fallbackUrl: string;
  ledger?: RpcCuLedgerRepositoryV1;
  now?: () => Date;
  /** Refreshed from storage no more often than this. A read path may not pay
   * for a ledger query on every batch. */
  refreshMs?: number;
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
  const alchemy = config.alchemyUrl ? createB20ReaderV1({ rpcUrl: config.alchemyUrl }) : null;
  const fallback = createB20ReaderV1({ rpcUrl: config.fallbackUrl });

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

  const pick = async (methods: readonly string[]) => {
    await refresh();
    const choice = chooseRpcEndpointV1({ spentCu, alchemyConfigured: alchemy !== null }, methods);
    return choice.provider === 'alchemy' && alchemy ? ('alchemy' as const) : ('fallback' as const);
  };

  return {
    async readBlockAnchor() {
      const provider = await pick(['eth_blockNumber']);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      const answer = await reader.readBlockAnchor();
      settle(provider, ['eth_blockNumber']);
      return answer;
    },
    async readIsB20(token, blockTag) {
      const provider = await pick(['eth_call']);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      const answer = await reader.readIsB20(token, blockTag);
      settle(provider, ['eth_call']);
      return answer;
    },
    async readIsB20Initialized(token, blockTag) {
      const provider = await pick(['eth_call']);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      const answer = await reader.readIsB20Initialized(token, blockTag);
      settle(provider, ['eth_call']);
      return answer;
    },
    async readVariantActivated(variant, blockTag) {
      const provider = await pick(['eth_call']);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      const answer = await reader.readVariantActivated(variant, blockTag);
      settle(provider, ['eth_call']);
      return answer;
    },
    async call(input) {
      const provider = await pick(['eth_call']);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      const answer = await reader.call(input);
      settle(provider, ['eth_call']);
      return answer;
    },
    async callMany(inputs: readonly B20BatchCallV1[]) {
      const methods = inputs.map(() => 'eth_call');
      const provider = await pick(methods);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      const answers = reader.callMany
        ? await reader.callMany(inputs)
        : await Promise.all(inputs.map((input) => reader.call(input)));
      settle(provider, methods);
      return answers;
    },
    async readTransaction(hash: string) {
      const provider = await pick(['eth_getTransactionByHash']);
      const reader = provider === 'alchemy' && alchemy ? alchemy : fallback;
      // Optional on the interface. A reader without it has nothing to bill.
      if (!reader.readTransaction) return { ok: false as const, reason: 'endpoint_unavailable' as const };
      const answer = await reader.readTransaction(hash);
      settle(provider, ['eth_getTransactionByHash']);
      return answer;
    },
  } as B20ReaderV1;
}
