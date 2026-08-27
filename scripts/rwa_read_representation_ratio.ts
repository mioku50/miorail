/**
 * The ratio between one token and one underlying share, read and stored.
 *
 * Base Docs open the tokenized-stocks page with a warning: "One B20 token does
 * not permanently equal one share. Always apply the current multiplier when
 * converting between token units and the number of underlying shares."
 *
 * Every Coinbase representation reads exactly 1e18 today. That is the reason
 * this exists NOW rather than after the first dividend: a value that is 1.0
 * everywhere is indistinguishable from a value nobody reads, right up until
 * the day it moves — and on that day a stored 1.0 becomes a lie about
 * somebody's share count.
 *
 * Why this stores history rather than a current value. `IB20Asset` documents a
 * scheduled-update surface — `uiMultiplier`, `newUIMultiplier`, `effectiveAt`
 * — that would give advance notice. Measured on Base at block 50,480,605, all
 * four of those functions revert on all thirteen deployed representations,
 * echoing their own selectors the way the precompile signals an unimplemented
 * function. There is therefore NO advance notice available from these tokens,
 * and comparing today's read against the stored one is the only way this
 * product can ever learn that a corporate action happened.
 *
 * Read-only: no signer, no key, no wallet, no transaction, no allowance.
 *
 *   pnpm rwa:read-ratio --dry
 *   pnpm rwa:read-ratio
 *   pnpm rwa:read-ratio --gap-ms 2000
 */
import {
  B20_SELECTORS_V1,
  callManyV1,
  createB20ReaderV1,
  decodeUint8V1,
  decodeUintV1,
  encodeNoArgsV1,
} from '@mioagent/b20-control';
import { client, closeDb } from '@mioagent/db';
import { stableHashV1 } from '@mioagent/route-domain';
import {
  createDatabaseIssuerRepresentationRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseRepresentationRatioRepository,
  createDatabaseRepresentationSupplyRepository,
  createDatabaseUnderlyingAssetRepository,
} from '@mioagent/route-storage';
import { readB20MultiplierV1 } from '@mioagent/rwa-dossier';
import { readDinariBalancePerShareV1 } from '@mioagent/rwa-issuer';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CHAIN_ID_V1 = 8453 as const;
/** Two reads per representation against an endpoint the measurement workers
 * share. Paced for the same reason they are. */
const DEFAULT_GAP_MS_V1 = 1_500;

function numericArgV1(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number.parseInt(String(process.argv[index + 1] ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `1.057380318816778075` from (raw, scale). Decimal-string arithmetic: a
 * float loses the last digits of a WAD, and those digits are the difference
 * between a share count that reconciles and one that does not. */
function normalizedV1(raw: string, scale: string): string {
  const places = scale.length - 1;
  if (places <= 0) return `${raw}.0`;
  const value = BigInt(raw);
  const divisor = BigInt(scale);
  return `${value / divisor}.${(value % divisor).toString().padStart(places, '0')}`;
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const gapMs = numericArgV1('--gap-ms', DEFAULT_GAP_MS_V1);
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = (process.env.BASE_MAINNET_RPC_URL || process.env.BASE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('BASE_MAINNET_RPC_URL is required to read a multiplier');

  const official = createDatabaseOfficialAssetRepository(client);
  const ratios = createDatabaseRepresentationRatioRepository(client);
  const supplies = createDatabaseRepresentationSupplyRepository(client);
  const issuers = createDatabaseIssuerRepresentationRepository(client);
  const underlyings = createDatabaseUnderlyingAssetRepository(client);
  const reader = createB20ReaderV1({ rpcUrl });

  // A reviewed issuer adapter selects its own corpus. Backed is also an
  // OFFICIAL source now, but calling the B20 multiplier selectors on a Backed
  // token would turn one issuer's convention into another issuer's evidence.
  const coinbaseB20 = await official.officialAssets({
    chainId: CHAIN_ID_V1,
    limit: 500,
    sourceKind: 'base_docs_technical',
  });
  // Every issuer gets its OWN adapter. Reading `multiplier()` off a dShare
  // would be a guess, and a guess of exactly that shape was measured to
  // contradict another issuer's own published value.
  const dinari = await issuers.establishedRepresentations({
    chainId: CHAIN_ID_V1,
    issuerId: 'dinari',
    limit: 500,
  });
  const underlyingRows = await underlyings.listUnderlyings({ chainId: CHAIN_ID_V1, limit: 500 });
  const reviewedBindings = (
    await Promise.all(
      underlyingRows.map((row) =>
        underlyings.representationsOf({
          chainId: CHAIN_ID_V1,
          underlyingKey: row.underlying.underlyingKey,
        }),
      ),
    )
  ).flat();
  console.log(
    `${coinbaseB20.length} reviewed Coinbase B20 representation(s), ` +
      `${dinari.length} established Dinari representation(s), ` +
      `${reviewedBindings.length} reviewed exact-address supply target(s)`,
  );
  if (coinbaseB20.length === 0 && dinari.length === 0 && reviewedBindings.length === 0) return;

  const anchorRead = await reader.readBlockAnchor();
  if (!anchorRead.ok) {
    // Every read is pinned to one block so the thirteen values describe one
    // moment. Without an anchor there is nothing to pin them to, and a mixed
    // set is worse than none.
    console.log(`  no block anchor (${anchorRead.reason}) — nothing read, nothing stored`);
    return;
  }
  const anchor = anchorRead.value;
  console.log(`  anchored at block ${anchor.blockNumber}`);

  if (dry) {
    console.log('  --dry: nothing read, nothing stored');
    return;
  }

  const now = new Date();

  let supplyRead = 0;
  let supplyZero = 0;
  let supplyFailed = 0;
  let supplyFirst = 0;
  let supplyChanged = 0;

  // Supply is universal ERC-20 evidence, unlike issuer-specific representation
  // ratios. Every reviewed exact address is asked the same pinned
  // totalSupply()/decimals() question; ticker and issuer never select it.
  for (const binding of reviewedBindings) {
    const [totalResult, decimalsResult] = await callManyV1(reader, [
      {
        to: binding.tokenAddress,
        data: encodeNoArgsV1(B20_SELECTORS_V1.totalSupply),
        blockTag: anchor.blockTag,
      },
      {
        to: binding.tokenAddress,
        data: encodeNoArgsV1(B20_SELECTORS_V1.decimals),
        blockTag: anchor.blockTag,
      },
    ]);
    const totalSupply = totalResult?.ok ? decodeUintV1(totalResult.value) : null;
    const decimals = decimalsResult?.ok ? decodeUint8V1(decimalsResult.value) : null;
    const successful = totalResult?.ok === true && decimalsResult?.ok === true;
    const decoded = successful && totalSupply !== null && decimals !== null;
    const failureCode = decoded
      ? null
      : successful
        ? 'erc20_supply_decode_failed'
        : `erc20_supply_rpc_${
            [
              totalResult && !totalResult.ok ? totalResult.reason : null,
              decimalsResult && !decimalsResult.ok ? decimalsResult.reason : null,
            ]
              .filter(Boolean)
              .join('_') || 'unavailable'
          }`;
    const evidenceHash = stableHashV1('representation-supply-read/v1', {
      chainId: CHAIN_ID_V1,
      tokenAddress: binding.tokenAddress,
      blockNumber: anchor.blockNumber,
      totalSupplyRaw: totalResult?.ok ? totalResult.raw : null,
      decimalsRaw: decimalsResult?.ok ? decimalsResult.raw : null,
      failureCode,
    });
    const stored = await supplies.recordObservation({
      chainId: CHAIN_ID_V1,
      tokenAddress: binding.tokenAddress,
      totalSupplyAtomic: decoded ? totalSupply.toString() : null,
      decimals: decoded ? decimals : null,
      blockNumber: anchor.blockNumber,
      blockHash: anchor.blockHash,
      evidenceHash,
      readOutcome: decoded ? 'success' : successful ? 'decode_failure' : 'rpc_failure',
      failureCode,
      observedAt: now.toISOString(),
      now: now.toISOString(),
    });
    if (decoded) {
      supplyRead += 1;
      if (totalSupply === 0n) supplyZero += 1;
      if (stored.outcome === 'first_observation') supplyFirst += 1;
      if (stored.outcome === 'changed') supplyChanged += 1;
      console.log(
        `  supply ${binding.tokenAddress}  ${totalSupply.toString()}  ${stored.row.state}  ${stored.outcome}`,
      );
    } else {
      supplyFailed += 1;
      console.log(`  supply ${binding.tokenAddress}  supply_unknown (${failureCode})`);
    }
    await sleep(gapMs);
  }

  console.log(
    `supply read ${supplyRead}, zero ${supplyZero}, unresolved ${supplyFailed} · ` +
      `${supplyFirst} first observation(s), ${supplyChanged} change(s)`,
  );

  let read = 0;
  let absent = 0;
  let failed = 0;
  const changed: string[] = [];
  const firstSeen: string[] = [];

  for (const asset of coinbaseB20) {
    const value = await readB20MultiplierV1(reader, {
      tokenAddress: asset.tokenAddress,
      anchor,
      now,
    });
    if (value.status !== 'read' || value.rawValue === null || value.scale === null) {
      // `absent` is the contract's answer; anything else is ours. Neither is
      // stored: a row that does not exist means "not read", which no surface
      // is allowed to render as one-to-one.
      if (value.status === 'absent') absent += 1;
      else failed += 1;
      console.log(`  ${asset.tokenAddress}  ${value.status} (${value.unavailableReason})`);
      await sleep(gapMs);
      continue;
    }
    read += 1;
    const outcome = await ratios.recordRead({
      chainId: CHAIN_ID_V1,
      tokenAddress: asset.tokenAddress,
      ratioKind: 'b20_multiplier',
      rawValue: value.rawValue,
      scale: value.scale,
      blockNumber: anchor.blockNumber,
      blockHash: anchor.blockHash,
      evidenceHash: value.evidence?.evidenceHash ?? '',
      observedAt: value.evidence?.observedAt ?? now.toISOString(),
      now: now.toISOString(),
    });
    if (outcome.outcome === 'changed') changed.push(asset.tokenAddress);
    if (outcome.outcome === 'first_observation') firstSeen.push(asset.tokenAddress);
    console.log(
      `  ${asset.tokenAddress}  ${normalizedV1(value.rawValue, value.scale)}  ${outcome.outcome}`,
    );
    await sleep(gapMs);
  }

  // Dinari, through its own adapter and its own ratio kind. `balanceOf` has
  // already applied this value, so the store carries
  // `already_applied_by_token` and nothing downstream may apply it twice.
  for (const representation of dinari) {
    const value = await readDinariBalancePerShareV1(reader, {
      tokenAddress: representation.tokenAddress,
      anchor,
    });
    if (value.outcome !== 'read') {
      if (value.outcome === 'absent') absent += 1;
      else failed += 1;
      console.log(`  ${representation.tokenAddress}  ${value.outcome} (${value.reason})`);
      await sleep(gapMs);
      continue;
    }
    read += 1;
    const outcome = await ratios.recordRead({
      chainId: CHAIN_ID_V1,
      tokenAddress: value.tokenAddress,
      ratioKind: 'dinari_balance_per_share',
      rawValue: value.rawValue,
      scale: value.scale,
      blockNumber: value.blockNumber,
      blockHash: value.blockHash,
      evidenceHash: value.evidenceHash,
      observedAt: now.toISOString(),
      now: now.toISOString(),
    });
    if (outcome.outcome === 'changed') changed.push(value.tokenAddress);
    if (outcome.outcome === 'first_observation') firstSeen.push(value.tokenAddress);
    console.log(`  ${value.tokenAddress}  ${value.normalized}  ${outcome.outcome}`);
    await sleep(gapMs);
  }

  console.log(
    `read ${read}, absent ${absent}, failed ${failed} · ${firstSeen.length} first observation(s), ${changed.length} change(s)`,
  );
  // A first observation is not a corporate action, and this pass says so out
  // loud: the day this first runs it must not read as thirteen splits.
  if (changed.length > 0) {
    console.log(`  CHANGED: ${changed.join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
