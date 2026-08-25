/**
 * Operator Phase 4 measurement: records the exact public cash ladder, then
 * immediately assembles the Phase 3 dossier while quote evidence is fresh.
 *
 * Read-only outside Miorail's evidence database. It has no signer, never calls
 * route/build, never creates approval calldata and never submits a transaction.
 *
 *   pnpm rwa:measure-cash-exit
 *   pnpm rwa:measure-cash-exit --tickers AAPLc,NVDAc
 */
import { createB20ReaderV1 } from '@mioagent/b20-control';
import { client } from '@mioagent/db';
import {
  createDatabaseMarketTailRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialCashExitRepository,
} from '@mioagent/route-storage';
import { measureOfficialCashExitV1 } from '@mioagent/rwa-cash-exit';
import { assembleOfficialAssetDossierV1 } from '@mioagent/rwa-dossier';
import { KyberSwapRouteAdapter } from '@mioagent/swap-adapters';

const MEASUREMENT_WALLET_V1 = '0x000000000000000000000000000000000000dead' as const;
const DECIMALS_SELECTOR_V1 = '0x313ce567';
const DEFAULT_TICKERS_V1 = ['AAPLc', 'NVDAc', 'GOOGLc', 'METAc'] as const;

function tickersV1(argv: readonly string[]): Set<string> {
  const index = argv.indexOf('--tickers');
  if (index < 0) return new Set(DEFAULT_TICKERS_V1);
  const values = (argv[index + 1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error('--tickers takes a comma-separated list');
  return new Set(values);
}

function rpcUrlV1(): string {
  const value = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!value) throw new Error('BASE_MAINNET_RPC_URL is required');
  return value;
}

function decodeDecimalsV1(raw: string): number | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  const value = Number(BigInt(raw));
  return Number.isInteger(value) && value >= 6 && value <= 18 ? value : null;
}

async function main(): Promise<void> {
  const requested = tickersV1(process.argv);
  const official = createDatabaseOfficialAssetRepository(client);
  const marketTail = createDatabaseMarketTailRepository(client);
  const cashExit = createDatabaseOfficialCashExitRepository(client);
  const reader = createB20ReaderV1({ rpcUrl: rpcUrlV1(), timeoutMs: 15_000 });
  const assets = (await official.officialAssets({ chainId: 8453, limit: 500 })).filter((identity) =>
    identity.listings.some((listing) => listing.currentlyListed && requested.has(listing.ticker)),
  );
  if (assets.length !== requested.size) {
    const found = new Set(
      assets.flatMap((asset) => asset.listings.map((listing) => listing.ticker)),
    );
    throw new Error(
      `reviewed corpus is missing requested ticker(s): ${[...requested].filter((ticker) => !found.has(ticker)).join(', ')}`,
    );
  }

  for (const identity of assets) {
    const listing = identity.listings.find(
      (entry) => entry.currentlyListed && requested.has(entry.ticker),
    )!;
    const anchor = await reader.readBlockAnchor();
    if (!anchor.ok)
      throw new Error(`${listing.ticker}: Base block anchor unavailable (${anchor.reason})`);
    const decimalRead = await reader.call({
      to: identity.tokenAddress,
      data: DECIMALS_SELECTOR_V1,
      blockTag: anchor.value.blockTag,
    });
    if (!decimalRead.ok)
      throw new Error(`${listing.ticker}: decimals unavailable (${decimalRead.reason})`);
    const decimals = decodeDecimalsV1(decimalRead.value);
    if (decimals === null) throw new Error(`${listing.ticker}: invalid B20 asset decimals`);

    const run = await measureOfficialCashExitV1({
      repository: cashExit,
      adapters: [new KyberSwapRouteAdapter()],
      token: { address: identity.tokenAddress as `0x${string}`, symbol: listing.ticker, decimals },
      walletAddress: MEASUREMENT_WALLET_V1,
      tenantId: 'official-cash-exit-operator',
      scope: 'public_ladder',
    });
    const dossier = await assembleOfficialAssetDossierV1(
      { official, marketTail, cashExit, reader, now: () => new Date() },
      { chainId: 8453, tokenAddress: identity.tokenAddress },
    );
    if (dossier.outcome !== 'dossier')
      throw new Error(`${listing.ticker}: exact address left reviewed corpus during measurement`);
    const usdc = dossier.dossier.cashExitLadder.rungs
      .filter((rung) => rung.destination === 'USDC')
      .map((rung) => ({
        requestedCashAtomic: rung.requestedCashAtomic,
        status: rung.status,
        roundTripCostBps: rung.roundTripCostBps,
      }));
    console.log(
      JSON.stringify({
        ticker: listing.ticker,
        tokenAddress: identity.tokenAddress,
        runId: run.runId,
        executableValue: dossier.dossier.executableValue,
        usdc,
      }),
    );
  }
}

main().catch((error) => {
  console.error(
    'cash-exit measurement failed:',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
