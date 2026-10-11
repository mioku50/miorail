import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { describe } from 'node:test';

import {
  InMemoryFoundShareRepositoryV1,
  isFoundShareCodeV1,
  newFoundShareCodeV1,
} from '../src/foundShares.js';

// ---------------------------------------------------------------------------
// Found's share cards: one per receipt, its owner's, holding only what the
// picture shows.
// ---------------------------------------------------------------------------

const RECEIPT = 'base-mcp-action:2b8f0c1e-4d5a-4c3b-9a7e-1f2e3d4c5b6a';
const at = new Date('2026-10-11T22:00:00.000Z');
const card = { receiptId: RECEIPT, tenantId: 'tenant-a', protocol: 'uniswap' as const, usdCents: 1_238,
  tokens: [{ symbol: 'WETH', amount: '0.0042' }, { symbol: 'USDC', amount: '1.53' }], blockNumber: '37123456', at };

describe('a card per receipt', () => {
  test('made once: a second ask returns the first card, and the code reads it back', async () => {
    const shares = new InMemoryFoundShareRepositoryV1();
    const first = await shares.make(card);
    assert.ok(isFoundShareCodeV1(first.code));
    assert.deepEqual(await shares.make({ ...card, usdCents: 9_999 }), first);
    assert.deepEqual(await shares.byCode(first.code), first);
    assert.deepEqual(await shares.byReceipt(RECEIPT, 'tenant-a'), first);
    assert.deepEqual(Object.keys(first).sort(), ['blockNumber', 'code', 'createdAt', 'protocol', 'receiptId', 'tokens', 'usdCents']);
  });

  test('another tenant can neither make nor read the card of a receipt it does not own', async () => {
    const shares = new InMemoryFoundShareRepositoryV1();
    await shares.make(card);
    await assert.rejects(shares.make({ ...card, tenantId: 'tenant-b' }), /owner/);
    assert.equal(await shares.byReceipt(RECEIPT, 'tenant-b'), null);
  });

  test('only what the picture shows, in its own shapes', async () => {
    const shares = new InMemoryFoundShareRepositoryV1();
    await assert.rejects(shares.make({ ...card, tokens: [] }), /one to four/);
    await assert.rejects(shares.make({ ...card, tokens: Array(5).fill(card.tokens[0]) }), /one to four/);
    await assert.rejects(shares.make({ ...card, tokens: [{ symbol: '<b>', amount: '1' }] }), /one to four/);
    await assert.rejects(shares.make({ ...card, tokens: [{ symbol: 'WETH', amount: '1e9' }] }), /one to four/);
    await assert.rejects(shares.make({ ...card, usdCents: 12.5 }), /whole cents/);
    await assert.rejects(shares.make({ ...card, protocol: 'morpho' as never }), /Aerodrome or Uniswap/);
    await assert.rejects(shares.make({ ...card, receiptId: 'x' }), /Action Receipt/);
    await assert.rejects(shares.make({ ...card, blockNumber: '0x1' }), /block/);
    assert.equal(await shares.byCode('not-a-code'), null);
  });

  test('a code is twelve base64url characters from nine random bytes', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newFoundShareCodeV1()));
    assert.equal(codes.size, 50);
    for (const code of codes) assert.ok(isFoundShareCodeV1(code), code);
  });
});

describe('the table and the SQL say the same', () => {
  const root = process.cwd().endsWith('lib/route-storage') ? resolve(process.cwd(), '..', '..') : process.cwd();
  const migration = readFileSync(resolve(root, 'lib/db/drizzle/0088_found_shares.sql'), 'utf8');
  const source = readFileSync(resolve(root, 'lib/route-storage/src/foundShares.ts'), 'utf8');

  test('the migration holds the rules the store enforces, and nothing that names a wallet', () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS found_shares/);
    assert.match(migration, /REFERENCES base_mcp_action_receipts \(id\)/);
    assert.match(migration, /CONSTRAINT found_shares_receipt_unique UNIQUE \(receipt_id\)/);
    assert.match(migration, /code ~ '\^\[A-Za-z0-9_-\]\{12\}\$'/);
    assert.match(migration, /protocol IN \('aerodrome', 'uniswap'\)/);
    assert.match(migration, /jsonb_array_length\(tokens\) BETWEEN 1 AND 4/);
    assert.match(migration, /ALTER TABLE found_shares OWNER TO miorail_user/);
    // The comments say why; the columns are the promise.
    const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf(');'));
    assert.doesNotMatch(table, /wallet|transaction_hash|tx_hash/i);
  });

  test('one card per receipt even when two clicks race, and jsonb bound as text', () => {
    assert.match(source, /ON CONFLICT \(receipt_id\) DO NOTHING/);
    assert.match(source, /::text::jsonb/);
  });

  test('the journal registers 0088 after 0087', () => {
    const journal = JSON.parse(readFileSync(resolve(root, 'lib/db/drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const entry = journal.entries.find((item) => item.tag === '0088_found_shares')!;
    assert.ok(entry);
    assert.equal(journal.entries[entry.idx - 1]?.tag, '0087_uniswap_collect_receipts');
    assert.ok(entry.when > journal.entries[entry.idx - 1]!.when);
  });
});
