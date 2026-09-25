/**
 * One pass of Base App notifications — what is said, to whom and how often is
 * in ./baseAppNotify.ts.
 *
 * Reads Miorail's own records and Base's list of wallets that turned
 * notifications on; writes only its cursor and a per-wallet daily count. No
 * signer, no chain write, no wallet. The Base Dashboard key is read from the
 * environment and is never printed.
 *
 *   pnpm base-app:notify --dry     reads and plans, sends and writes nothing
 *   pnpm base-app:notify
 */
import { callManyV1, createB20ReaderV1 } from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import {
  createDatabaseBaseAppNotificationRepositoryV1,
  createDatabaseOfficialAssetRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseUnderlyingAssetRepository,
  readPublicLadderMidsV1,
} from '@mioagent/route-storage';
import { weekendWindowV1, weeklyCloseChangesV1 } from '@mioagent/rwa-market-reality/weekend-market';

import {
  baseAppNotifyConfigV1,
  createBaseAppNotifyClientV1,
  multiplierChangePpmV1,
  runBaseAppNotifyV1,
  type HoldingsV1,
  type StockNamesV1,
} from './baseAppNotify.js';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const config = baseAppNotifyConfigV1(process.env);
  if (!config) {
    console.log(JSON.stringify({ event: 'base_app_notify', outcome: 'off' }));
    return;
  }

  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const official = createDatabaseOfficialAssetRepository(client);
  const ratios = createDatabaseRepresentationRatioRepository(client);
  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();

  // Balances at ONE block, so a wallet is a holder or not at a single moment.
  // A read that fails throws: the caller treats that as "unknown", never as
  // "holds nothing".
  const holdings = async (wallets: readonly string[], tokens: readonly string[]): Promise<HoldingsV1> => {
    if (!rpcUrl) throw new Error('no_rpc');
    const reader = createB20ReaderV1({ rpcUrl });
    const anchor = await reader.readBlockAnchor();
    if (!anchor.ok) throw new Error('no_block');
    const pairs = wallets.flatMap((wallet) => tokens.map((token) => ({ wallet, token })));
    const results = await callManyV1(
      reader,
      pairs.map(({ wallet, token }) => ({
        to: token,
        // balanceOf(address)
        data: `0x70a08231${wallet.slice(2).toLowerCase().padStart(64, '0')}`,
        blockTag: anchor.value.blockTag,
      })),
    );
    const held = new Map<string, Set<string>>();
    results.forEach((result, index) => {
      if (!result.ok) throw new Error('balance_unread');
      const pair = pairs[index]!;
      if (/^0x[0-9a-fA-F]+$/.test(result.value) && BigInt(result.value) > 0n) {
        held.set(pair.wallet, new Set([...(held.get(pair.wallet) ?? []), pair.token.toLowerCase()]));
      }
    });
    return held;
  };

  const report = await runBaseAppNotifyV1({
    repository: createDatabaseBaseAppNotificationRepositoryV1(client),
    client: createBaseAppNotifyClientV1({ config }),
    // A lookup that fails fails the pass, which advances nothing: a push is
    // never dropped because a name could not be read this minute.
    names: async (tokens) => {
      const found = new Map<string, StockNamesV1>();
      for (const token of new Set(tokens.map((address) => address.toLowerCase()))) {
        const [binding, identity] = await Promise.all([
          underlyings.underlyingOf({ chainId: 8453, tokenAddress: token }),
          official.officialIdentity({ chainId: 8453, tokenAddress: token }),
        ]);
        const symbol = binding?.underlying.displaySymbol ?? null;
        const representation = identity?.listings[0]?.ticker ?? null;
        if (symbol || representation) found.set(token, { symbol, representation, issuer: identity?.issuer ?? null });
      }
      return (address) => found.get(address.toLowerCase()) ?? null;
    },
    now: () => new Date(),
    dry,
    holdings,
    previousMultipliers: async () => {
      const changes = await ratios.recentChanges({ chainId: 8453, limit: 200 });
      return (token, toWad) =>
        changes.find((change) => change.tokenAddress === token.toLowerCase() && change.toRawValue === toWad)
          ?.fromRawValue ?? null;
    },
    weekly: async (now) => {
      const window = weekendWindowV1(now);
      if (!window) return null;
      // From four hours before the previous week's close to now: both closes
      // need a print to come from.
      const since = new Date(Date.parse(window.closeAt) - (7 * 24 + 4) * 3_600_000);
      const rows = await readPublicLadderMidsV1(client, { since, until: now });
      const byToken = new Map<string, typeof rows>();
      for (const row of rows) byToken.set(row.token, [...(byToken.get(row.token) ?? []), row]);
      const stocks = [];
      for (const [token, runs] of byToken) {
        const binding = await underlyings.underlyingOf({ chainId: 8453, tokenAddress: token });
        if (!binding) continue;
        stocks.push({
          tokenAddress: token,
          symbol: binding.underlying.displaySymbol ?? binding.underlying.canonicalName,
          name: binding.underlying.canonicalName,
          runs,
        });
      }
      const week = weeklyCloseChangesV1({ now, stocks });
      if (!week) return null;
      // A dividend this week: a Coinbase stock whose multiplier rose a little
      // between the two closes.
      const changes = await ratios.recentChanges({ chainId: 8453, limit: 200 });
      const dividends = new Set<string>();
      for (const change of changes) {
        const at = Date.parse(change.observedAt);
        if (at <= Date.parse(week.previousCloseAt) || at > now.getTime()) continue;
        const ppm = multiplierChangePpmV1(change.fromRawValue, change.toRawValue);
        if (ppm === null || ppm <= 0 || ppm >= 50_000) continue;
        const identity = await official.officialIdentity({ chainId: 8453, tokenAddress: change.tokenAddress });
        if ((identity?.issuer ?? '').toLowerCase().startsWith('coinbase')) dividends.add(change.tokenAddress);
      }
      return { week, dividends };
    },
  });
  console.log(JSON.stringify({ event: 'base_app_notify', dry, ...report }));
  // Base down or throttling is a later pass's problem; a key Base no longer
  // takes is the operator's, and a failed unit is how that gets seen.
  if (report.stoppedBy && /http_(401|403|404)$/.test(report.stoppedBy)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('base app notify failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
