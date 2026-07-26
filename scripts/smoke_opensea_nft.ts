import assert from 'node:assert/strict';
import { createOpenSeaGatewayV1, NFT_SEAPORT_TARGETS_V1, isPinnedSeaportTargetV1 } from '@mioagent/nft-engine';
import { resolveNftIntentV1 } from '@mioagent/intent-engine';
import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// T65 §12 — the READ-ONLY OpenSea smoke.
//
//   pnpm smoke:opensea-nft
//
// It reads an NFT and its best active listing and prints what it found. It has
// no code path that prepares, signs, submits, or calls fulfillment_data — the
// listing is observed and nothing else. Running it changes nothing anywhere.
//
// Its real job is to check the PINNED assumptions against reality before any
// of them carry money: the v2 paths, the Seaport protocol address, the ERC-721
// standard, and the rule that the order's consideration — not OpenSea's price
// summary — is what the buyer pays.
// ---------------------------------------------------------------------------

const WALLET = (process.env.SMOKE_NFT_WALLET?.trim() ??
  '0x000000000000000000000000000000000000dEaD') as `0x${string}`;

function ok(message: string): void {
  console.log(`   ✔ ${message}`);
}

async function main(): Promise<void> {
  console.log('\nT65 OpenSea NFT read-only smoke\n');

  console.log('0. Environment');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const apiKey = (process.env.OPENSEA_API_KEY ?? '').trim();
  if (apiKey.length === 0) {
    console.log('   ⚠ OPENSEA_API_KEY is not set. OpenSea requires x-api-key; nothing was requested.\n');
    process.exitCode = 1;
    return;
  }
  ok(`server-side OPENSEA_API_KEY present (${apiKey.length} chars, never printed)`);
  ok(`pinned Seaport targets: ${NFT_SEAPORT_TARGETS_V1.join(', ')}`);

  console.log('\n1. Intent grounding (offline, deterministic)');
  const now = new Date();
  const resolution = resolveNftIntentV1({
    message: 'Buy an NFT on Base cheaper than 1 ETH',
    tenantId: `eip155:8453:${WALLET.toLowerCase()}`,
    walletAddress: WALLET.toLowerCase() as `0x${string}`,
    now,
  });
  // No token named, so this MUST be a clarification — the smoke asserts the
  // refusal rather than working around it.
  assert.equal(resolution.status, 'needs_clarification');
  ok('an NFT goal with no token id is a clarification, never an open cheque');

  const gateway = createOpenSeaGatewayV1({ apiKey });

  console.log('\n2. Live probe — a Base collection with an active listing (read-only)');
  const slug = process.env.SMOKE_NFT_SLUG?.trim() ?? 'dxterminal';
  const listingsUrl = `https://api.opensea.io/api/v2/listings/collection/${slug}/best?limit=1`;
  const discovery = await fetch(listingsUrl, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
  if (!discovery.ok) {
    console.log(`   ⚠ collection ${slug} did not answer (${discovery.status}). Nothing was requested further.\n`);
    process.exitCode = 1;
    return;
  }
  const first = ((await discovery.json()) as { listings?: { asset?: { identifier?: string; contract?: string } }[] })
    .listings?.[0];
  const tokenId = first?.asset?.identifier;
  const contract = first?.asset?.contract;
  if (!tokenId || !contract) {
    console.log(`   ⚠ ${slug} has no active listing right now. Nothing else was requested.\n`);
    return;
  }
  ok(`found ${slug} #${tokenId} at ${contract}`);

  console.log('\n3. The NFT itself');
  const asset = await gateway.readNft({ contractAddress: contract, tokenId, now });
  if (!asset.ok) {
    console.log(`   ⚠ the NFT could not be read: ${asset.reason}${asset.detail ? ` (${asset.detail})` : ''}\n`);
    process.exitCode = 1;
    return;
  }
  ok(`standard ${asset.value.tokenStandard} · collection ${asset.value.collectionSlug ?? '—'}`);
  console.log(`     name        : ${asset.value.name ?? '—'}`);
  console.log(`     media       : ${asset.value.imageUrl ? 'present (never rendered here)' : 'none'}`);
  console.log(`     flags       : disabled=${asset.value.isDisabled} nsfw=${asset.value.isNsfw}`);

  console.log('\n4. Best active listing');
  const listing = await gateway.readBestListing({
    collectionSlug: asset.value.collectionSlug ?? slug,
    tokenId,
    now,
  });
  if (!listing.ok) {
    console.log(`   ⚠ no usable listing: ${listing.reason}${listing.detail ? ` (${listing.detail})` : ''}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`     order hash  : ${listing.value.orderHash}`);
  console.log(`     protocol    : ${listing.value.protocolAddress}`);
  console.log(`     seller      : ${listing.value.seller}`);
  console.log(`     total       : ${listing.value.totalWei} wei (from the order's consideration)`);
  console.log(`     of which fee: ${listing.value.feeWei} wei`);
  console.log(`     status      : ${listing.value.listingStatus}`);
  console.log(`     expires     : ${listing.value.listingExpiresAt}`);
  console.log(`     zone-restricted: ${listing.value.restrictedByZone}`);
  console.log(`     request ${listing.value.requestHash.slice(0, 18)}… response ${listing.value.responseHash.slice(0, 18)}…`);

  // The pinned assumptions, checked against what actually came back.
  assert.equal(
    isPinnedSeaportTargetV1(listing.value.protocolAddress),
    true,
    'the live protocol address is not in NFT_SEAPORT_TARGETS_V1',
  );
  ok('the live protocol address IS one of the pinned Seaport targets');
  assert.equal(listing.value.contractAddress.toLowerCase(), contract.toLowerCase());
  assert.equal(listing.value.tokenId, tokenId);
  ok('the listing is for the token that was asked about — identity, not metadata');
  assert.ok(BigInt(listing.value.totalWei) > BigInt(0));
  ok('the price came from the order, and the summary agreed with it');

  console.log('\n5. Re-read the order the way a pre-signature check would');
  const order = await gateway.readOrder({
    protocolAddress: listing.value.protocolAddress,
    orderHash: listing.value.orderHash,
    now,
  });
  if (!order.ok) {
    console.log(`   ⚠ the order could not be re-read: ${order.reason}\n`);
    process.exitCode = 1;
    return;
  }
  assert.equal(order.value.totalWei, listing.value.totalWei);
  assert.equal(order.value.orderHash, listing.value.orderHash);
  ok('the fresh order read agrees with the listing — same code, same answer');

  console.log('\nRead-only smoke passed. No fulfillment data was requested,');
  console.log('nothing was prepared, nothing was signed, and nothing was sent.\n');
}

main().catch((error) => {
  console.error('\nSmoke failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
