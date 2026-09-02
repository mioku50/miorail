/**
 * Bind Dinari's Base dShares to the securities Dinari itself publishes.
 *
 * A hundred dShare contracts sit on Base, proven to be dShares by the factory's
 * own predicate, with no binding to any security — so none of them reached
 * Stocks, and the surface opened on nine live securities out of a corpus of
 * twenty-four.
 *
 * The binding this writes is, in order of preference:
 *
 *   1. BY ADDRESS, when the catalogue's `tokens` array names the exact Base
 *      contract. That is the issuer answering directly and needs nothing else.
 *   2. BY SYMBOL, when it does not — which is what the sandbox environment
 *      returns, since production access is gated behind a verification form
 *      that is currently closed. Both sides of that join are the same issuer's
 *      own publication: `symbol()` on a contract Dinari's factory deployed, and
 *      the symbol on Dinari's own stock row. Any repeated symbol on either side
 *      refuses every contract carrying it rather than picking one.
 *
 * Nothing is written on a symbol alone. Every match must also survive:
 *
 *   * a composite FIGI on the stock row, and
 *   * OpenFIGI — the registry that ISSUES composite FIGIs — returning the same
 *     one for that ticker. A different FIGI is a refusal, not a correction:
 *     two sources disagreeing about which security this is means neither may be
 *     stored.
 *
 * The same OpenFIGI answer supplies the asset class, so `equity` versus
 * `fund_share` comes from the registry rather than from whether "Trust" appears
 * in a company name.
 *
 *   pnpm tsx scripts/rwa_bind_dinari_representations.ts --dry-run
 *   pnpm tsx scripts/rwa_bind_dinari_representations.ts --commit
 */
import { createHash } from 'node:crypto';

import { callManyV1, createB20ReaderV1, decodeStringV1 } from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import { createDatabaseUnderlyingAssetRepository } from '@mioagent/route-storage';
import {
  DINARI_STOCKS_PATH_V1,
  DINARI_STOCK_API_ENVIRONMENTS_V1,
  dinariSourceStateV1,
  dinariUnderlyingKeyV1,
  fetchDinariStocksV1,
  joinDinariBySymbolV1,
  lookupOpenFigiV1,
  openFigiVerdictV1,
  assetClassFromSecurityTypeV1,
  type DinariOnchainDShareV1,
  type DinariStockApiEnvironmentV1,
  type DinariStockV1,
} from '@mioagent/rwa-issuer';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const SYMBOL_SELECTOR_V1 = '0x95d89b41';
const CHAIN_ID_V1 = 8453;
const REPRESENTATION_KIND_V1 = 'dinari_dshare';

function rpcUrlV1(): string {
  // The read RPC, and the Alchemy endpoint ahead of it when one is configured:
  // this walks a hundred contracts and the public endpoint caps a JSON-RPC
  // batch at ten calls.
  return (
    process.env.ALCHEMY_BASE_MAINNET_RPC_URL ||
    process.env.BASE_MAINNET_RPC_URL ||
    process.env.BASE_RPC_URL ||
    ''
  ).trim();
}

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const commit = process.argv.includes('--commit');
  const rpcUrl = rpcUrlV1();
  if (!rpcUrl) throw new Error('no Base RPC URL is configured');

  const credentialState = dinariSourceStateV1(process.env);
  if (credentialState !== 'ready') {
    // Not a failure of the source: it is the state of this deployment, and it
    // must never be rendered as Dinari being unreachable.
    console.log(`dinari credentials: ${credentialState} — nothing to read`);
    return;
  }
  const credentials = {
    apiKeyId: (process.env.DINARI_API_KEY_ID ?? '').trim(),
    apiSecretKey: (process.env.DINARI_API_SECRET_KEY ?? '').trim(),
  };
  const configured = (process.env.DINARI_ENVIRONMENT ?? 'sandbox').trim().toLowerCase();
  // Sandbox on anything unrecognised. Reaching production by a typo is not a
  // mistake this script will make.
  const environment: DinariStockApiEnvironmentV1 =
    configured === 'live' || configured === 'production' ? 'live' : 'sandbox';
  const sourceRef = `${DINARI_STOCK_API_ENVIRONMENTS_V1[environment]}${DINARI_STOCKS_PATH_V1}`;

  const raw = await client`
    SELECT lower(token_address) AS token_address
      FROM issuer_representation
     WHERE issuer_id = 'dinari'
     ORDER BY 1`;
  const rows = raw
    .map((row) => String((row as { token_address?: unknown }).token_address ?? ''))
    .filter((address) => /^0x[0-9a-f]{40}$/.test(address));
  console.log(`dinari contracts on file: ${rows.length}`);

  // Symbols, at one block, so a snapshot cannot straddle two.
  const reader = createB20ReaderV1({ rpcUrl });
  const anchor = await reader.readBlockAnchor();
  if (!anchor.ok) throw new Error(`no block anchor: ${anchor.reason}`);
  const blockTag = anchor.value.blockTag;
  const onchain: DinariOnchainDShareV1[] = [];
  for (let index = 0; index < rows.length; index += 8) {
    const chunk = rows.slice(index, index + 8);
    const answers = await callManyV1(
      reader,
      chunk.map((address) => ({ to: address, data: SYMBOL_SELECTOR_V1, blockTag })),
    );
    chunk.forEach((address, position) => {
      const answer = answers[position];
      onchain.push({
        tokenAddress: address,
        symbol: answer?.ok ? decodeStringV1(answer.value) : null,
      });
    });
  }
  const withSymbol = onchain.filter((row) => row.symbol);
  console.log(`symbols read at block ${blockTag}: ${withSymbol.length} of ${onchain.length}`);

  // Paged here rather than in the client: the client reads one page, and a
  // page that repeats what we already hold is the end of a list whose paging
  // we do not control — continuing would loop.
  const byStockId = new Map<string, DinariStockV1>();
  for (let page = 1; page <= 40; page += 1) {
    const answer = await fetchDinariStocksV1({ credentials, environment, pageSize: 100, page });
    if (!answer.ok) {
      if (page === 1) throw new Error(`dinari catalogue: ${answer.reason} — ${answer.detail}`);
      break;
    }
    if (answer.stocks.length === 0) break;
    const before = byStockId.size;
    for (const stock of answer.stocks) byStockId.set(stock.id, stock);
    if (byStockId.size === before) break;
    if (answer.stocks.length < 100) break;
  }
  const stocks = [...byStockId.values()];
  if (stocks.length === 0) throw new Error('dinari catalogue returned no stock rows');
  console.log(`catalogue: ${stocks.length} stocks from ${sourceRef}`);

  const join = joinDinariBySymbolV1({ onchain, catalogue: stocks, chainId: CHAIN_ID_V1 });
  const byIssuer = join.matched.filter((match) => match.namedByIssuer).length;
  console.log(
    `joined: ${join.matched.length} (${byIssuer} named by the issuer, ${join.matched.length - byIssuer} by symbol)`,
  );
  const refusedByReason = new Map<string, number>();
  for (const refusal of join.refused) {
    refusedByReason.set(refusal.reason, (refusedByReason.get(refusal.reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...refusedByReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  refused ${count.toString().padStart(3)}  ${reason}`);
  }

  // One FIGI cross-check per distinct security, not per contract.
  const tickers = [...new Set(join.matched.map((match) => match.joinSymbol))].sort();
  console.log(`cross-checking ${tickers.length} tickers against OpenFIGI…`);
  const figiByTicker = await lookupOpenFigiV1(
    tickers.map((ticker) => ({ ticker })),
    { apiKey: process.env.OPENFIGI_API_KEY ?? null },
  );

  // ---------------------------------------------------------------------
  // One company, one underlying, however many identifier schemes name it.
  //
  // Apple is already in this corpus as `security:isin:US0378331005`, declared
  // from Coinbase's onchain metadata. Declaring Dinari's Apple as a second
  // underlying would put one company on the chooser twice, with its
  // representations split across two cards — which is the denominator
  // separation this product exists to keep, inverted into a defect.
  //
  // So every underlying already held by ISIN is mapped to its composite FIGI by
  // the same registry, and a Dinari stock whose FIGI matches one of them binds
  // to THAT key. A new key is issued only for a security nobody here holds.
  // ---------------------------------------------------------------------
  const existing = await client`
    SELECT underlying_key, identifier_scheme, identifier_value
      FROM underlying_asset
     WHERE identifier_scheme = 'isin' AND identifier_value IS NOT NULL`;
  const isins = existing
    .map((row) => String((row as { identifier_value?: unknown }).identifier_value ?? ''))
    .filter((value) => value.length > 0);
  const keyByIsin = new Map(
    existing.map((row) => [
      String((row as { identifier_value?: unknown }).identifier_value ?? ''),
      String((row as { underlying_key?: unknown }).underlying_key ?? ''),
    ]),
  );
  console.log(`reconciling ${isins.length} ISIN-held underlyings against OpenFIGI…`);
  const figiByIsin = await lookupOpenFigiV1(
    isins.map((isin) => ({ ticker: isin, idType: 'ID_ISIN' as const })),
    { apiKey: process.env.OPENFIGI_API_KEY ?? null },
  );
  const existingKeyByFigi = new Map<string, string>();
  for (const [isin, rows] of figiByIsin) {
    const figi = rows.find((row) => row.compositeFigi)?.compositeFigi?.trim().toUpperCase();
    const key = keyByIsin.get(isin);
    if (figi && key) existingKeyByFigi.set(figi, key);
  }
  console.log(`  reconciled ${existingKeyByFigi.size} of ${isins.length} to a composite FIGI`);

  const repository = createDatabaseUnderlyingAssetRepository(client);
  const observedAt = new Date().toISOString();
  let declared = 0;
  let bound = 0;
  let reusedExisting = 0;
  const rejected = new Map<string, number>();
  const seenUnderlyings = new Set<string>();

  for (const match of join.matched) {
    const figi = match.stock.composite_figi?.trim().toUpperCase() ?? null;
    if (!figi) {
      rejected.set('no_composite_figi', (rejected.get('no_composite_figi') ?? 0) + 1);
      continue;
    }
    const rowsForTicker = figiByTicker.get(match.joinSymbol);
    if (rowsForTicker === undefined) {
      // Absent, not empty: the registry was never asked successfully, which is
      // our gap and not a statement about the security.
      rejected.set('openfigi_unread', (rejected.get('openfigi_unread') ?? 0) + 1);
      continue;
    }
    const verdict = openFigiVerdictV1(figi, rowsForTicker);
    if (verdict.state !== 'agrees') {
      rejected.set(`openfigi_${verdict.state}`, (rejected.get(`openfigi_${verdict.state}`) ?? 0) + 1);
      continue;
    }

    const reconciled = existingKeyByFigi.get(figi) ?? null;
    const underlyingKey = reconciled ?? dinariUnderlyingKeyV1(match.stock.id);
    const assetClass = assetClassFromSecurityTypeV1(
      verdict.row.securityType,
      verdict.row.securityType2,
    );
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          stockId: match.stock.id,
          symbol: match.stock.symbol,
          compositeFigi: figi,
          sourceRef,
        }),
      )
      .digest('hex');

    // A reconciled key belongs to a source that already declared it. Declaring
    // it again from here would rename somebody else's asset.
    if (reconciled === null && !seenUnderlyings.has(underlyingKey)) {
      seenUnderlyings.add(underlyingKey);
      declared += 1;
      if (commit) {
        await repository.declareUnderlying({
          underlyingKey,
          assetClass,
          canonicalName: match.stock.name,
          displaySymbol: match.stock.symbol,
          identifierScheme: 'dinari_stock_id',
          identifierValue: match.stock.id,
          sourceKind: 'dinari_stock_api',
          sourceRef,
          sourceHash,
          observedAt,
        });
      }
    }

    bound += 1;
    if (reconciled !== null) reusedExisting += 1;
    if (commit) {
      await repository.bindRepresentation({
        chainId: CHAIN_ID_V1,
        tokenAddress: match.tokenAddress,
        underlyingKey,
        issuerId: 'dinari',
        issuerInstrumentKey: match.stock.id,
        caip10: `eip155:${CHAIN_ID_V1}:${match.tokenAddress}`,
        representationKind: REPRESENTATION_KIND_V1,
        // The issuer publishes the identifier; the address side is its own
        // contract read on chain. Never the stronger machine-mapping strength,
        // which would claim the mapping itself was cross-checked on chain.
        evidenceStrength: 'reviewed_issuer_identifier',
        sourceKind: 'dinari_stock_api',
        sourceRef,
        sourceHash,
        observedAt,
        observedBlockNumber: anchor.value.blockNumber,
        observedBlockHash: anchor.value.blockHash,
      });
    }
  }

  for (const [reason, count] of [...rejected].sort((a, b) => b[1] - a[1])) {
    console.log(`  rejected ${count.toString().padStart(3)}  ${reason}`);
  }
  console.log(
    `${commit ? 'WROTE' : 'DRY RUN'}: ${declared} new underlyings, ${reusedExisting} bound to an underlying already held, ${bound} representation bindings in total`,
  );
  if (!commit) console.log('re-run with --commit to write');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
