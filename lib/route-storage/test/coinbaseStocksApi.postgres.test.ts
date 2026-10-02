import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test, { before, after } from 'node:test';
import postgres from 'postgres';

const url = process.env.MIOAGENT_MIGRATION_TEST_URL;
const local = Boolean(
  url && /(?:localhost|127\.0\.0\.1)/.test(url) && !/neon|amazonaws/i.test(url),
);
let sql: ReturnType<typeof postgres>;
let dir: string;
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

before(async () => {
  if (!local) return;
  sql = postgres(url!, { max: 1, onnotice: () => {} });
  dir = await mkdtemp(join(tmpdir(), 'miorail-coinbase-api-'));
  // This test requires a disposable database. A fresh instance also exercises
  // the real migration chain and source enums, not a simplified test schema.
  await run(process.execPath, ['--import', 'tsx', 'lib/db/migrate.ts'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', MIOAGENT_TEST_SUITE: 'db', TEST_DATABASE_URL: url },
  });
});
after(async () => {
  await sql?.end({ timeout: 5 });
  if (dir) await rm(dir, { recursive: true, force: true });
});

test(
  'issuer API ingestion: separate provenance, silent baseline, repeat, failure and new listing',
  { skip: !local },
  async () => {
    const fixture = JSON.parse(
      await readFile(join(root, 'lib/rwa-official/test/fixtures/coinbase-stocks-api.json'), 'utf8'),
    );
    const fixturePath = join(dir, 'api.json');
    const hook = join(dir, 'fetch.mjs');
    await writeFile(fixturePath, JSON.stringify(fixture));
    await writeFile(
      hook,
      `import {readFileSync} from 'node:fs';
    globalThis.fetch = async (url) => new Response(
      String(url) === 'https://api.coinbase.com/v1/tokenized-stocks' ? readFileSync(process.env.STOCKS_API_FIXTURE, 'utf8') : '{}',
      {status: String(url) === 'https://api.coinbase.com/v1/tokenized-stocks' ? 200 : 503});`,
    );
    const worker = async () => {
      // Other sources are deliberately unavailable. Their failures must not stop
      // the API read or turn the existing API corpus into delisted addresses.
      try {
        await run(
          process.execPath,
          ['--import', 'tsx', '--import', hook, 'scripts/rwa_ingest_official.ts'],
          {
            cwd: root,
            env: {
              ...process.env,
              NODE_ENV: 'test',
              MIOAGENT_TEST_SUITE: 'db',
              TEST_DATABASE_URL: url,
              STOCKS_API_FIXTURE: fixturePath,
            },
          },
        );
      } catch (error) {
        assert.equal((error as { code?: number }).code, 1);
        assert.match((error as { stderr: string }).stderr, /SOURCE NOT READ/);
      }
    };
    await sql`TRUNCATE official_asset_sources, underlying_identity_observation, representation_underlying, underlying_asset, rwa_signals, rwa_signal_watch RESTART IDENTITY CASCADE`;
    await worker();
    assert.equal(
      (
        await sql`SELECT count(*)::int AS n FROM official_assets WHERE source_kind = 'coinbase_stocks_api'`
      )[0].n,
      58,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS n FROM representation_underlying WHERE source_kind = 'coinbase_stocks_api'`
      )[0].n,
      58,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS n FROM underlying_identity_observation WHERE source_kind = 'coinbase_stocks_api'`
      )[0].n,
      58,
    );
    assert.equal(
      (await sql`SELECT count(*)::int AS n FROM rwa_signals`)[0].n,
      0,
      'first observation is not 58 news items',
    );
    await worker();
    assert.equal((await sql`SELECT count(*)::int AS n FROM rwa_signals`)[0].n, 0);
    await writeFile(fixturePath, '{"tokens":[]}');
    await worker();
    const failed =
      await sql`SELECT status, asset_count FROM official_asset_sources WHERE source_kind = 'coinbase_stocks_api' ORDER BY id DESC LIMIT 1`;
    assert.equal(failed[0].status, 'unparsable');
    assert.equal(failed[0].asset_count, 0);
    assert.equal(
      (
        await sql`SELECT count(*)::int AS n FROM official_assets WHERE source_kind = 'coinbase_stocks_api'`
      )[0].n,
      58,
    );
    assert.equal((await sql`SELECT count(*)::int AS n FROM rwa_signals`)[0].n, 0);
    fixture.tokens.push({
      ...fixture.tokens[0],
      contract_address: '0xb200000000000000000000000000000000000001',
      symbol: 'NEWc',
    });
    await writeFile(fixturePath, JSON.stringify(fixture));
    await worker();
    const signals = await sql`SELECT kind, facts FROM rwa_signals`;
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, 'official_source_added_asset');
    assert.equal(signals[0].facts.sourceKind, 'coinbase_stocks_api');
    await worker();
    assert.equal(
      (await sql`SELECT count(*)::int AS n FROM rwa_signals`)[0].n,
      1,
      'refresh is idempotent',
    );
  },
);
