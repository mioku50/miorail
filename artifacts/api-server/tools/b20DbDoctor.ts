import { createHash } from 'node:crypto';

import { client, closeDb, databaseConnectionInfo } from '@mioagent/db';
import { B20MarketRailsResponseV1Schema, B20OpportunityFeedResponseV1Schema } from '@mioagent/api-zod';
import { createDatabaseB20ObservationRepository } from '@mioagent/route-storage';

import { safeValueCategoryV1, safeZodIssuesV1 } from '../lib/safeZodIssues.js';
import { DISCOVER_FEED_WINDOW_MS_V1, pipelineStatusV1, readDiscoverFeedV1 } from '../routes/b20Control.js';

// ---------------------------------------------------------------------------
// T73-LIVE-DB §1/§3 — the Discover path, walked one stage at a time.
//
// The Discover feed answered 500 with `name: "ZodError"` while market rails
// answered 200 from the same database. A parallel SQL query cannot explain
// that, because a parallel SQL query is not what production runs. So this
// imports EXACTLY what the HTTP handler imports — the same repository factory,
// the same `readDiscoverFeedV1`, the same response schema — and reports which
// stage stops working.
//
// It is read-only: every statement here is a SELECT, and there is no writer in
// the process.
//
// It prints no credential. The connection is identified by a FINGERPRINT (a
// truncated hash of the URL) which is enough to prove two processes share a
// database and useless to anybody who obtains it.
// ---------------------------------------------------------------------------

function fingerprintV1(value: string | undefined): string {
  if (!value) return '(unset)';
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** local / remote, without naming the host. Enough to prove production is not
 * still talking to Neon. */
function hostClassV1(url: string | undefined): string {
  if (!url) return 'unknown';
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
    if (/\.neon\.tech$/i.test(host)) return 'remote:neon';
    return 'remote';
  } catch {
    return 'unparseable';
  }
}

const stages: { stage: string; ok: boolean; detail: string }[] = [];

function record(stage: string, ok: boolean, detail = ''): void {
  stages.push({ stage, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${stage}${detail ? ` — ${detail}` : ''}`);
}

function reportZodV1(stage: string, error: unknown, input: unknown): void {
  const issues = safeZodIssuesV1(error, input);
  if (!issues) {
    record(stage, false, error instanceof Error ? `${error.name}` : 'unknown error');
    return;
  }
  record(stage, false, `${issues.length} schema issue(s)`);
  for (const issue of issues) {
    console.log(
      `        ${issue.path}  code=${issue.code}` +
        `${issue.expected ? ` expected=${issue.expected}` : ''} received=${issue.receivedType}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('T73-LIVE-DB — B20 storage doctor');

  // --- §1 which database is this, really -----------------------------------
  console.log('\n1. Database identity');
  const url = process.env.DATABASE_URL;
  console.log(`  DATABASE_URL fingerprint  ${fingerprintV1(url)}`);
  console.log(`  host class                ${hostClassV1(url)}`);
  console.log(`  driver source             ${databaseConnectionInfo.source}`);

  const identity = await client`
    SELECT current_database() AS db, current_user AS usr, version() AS version,
           current_setting('server_version') AS server_version,
           current_setting('max_connections') AS max_connections,
           pg_backend_pid() AS pid`;
  const row = (identity[0] ?? {}) as Record<string, unknown>;
  console.log(`  current_database()        ${String(row.db)}`);
  console.log(`  current_user              ${String(row.usr)}`);
  console.log(`  server_version            ${String(row.server_version)}`);
  console.log(`  max_connections           ${String(row.max_connections)}`);
  record('the database answered', true, `PostgreSQL ${String(row.server_version)}`);
  record(
    'PostgreSQL 18',
    String(row.server_version).startsWith('18.'),
    String(row.server_version),
  );
  record('not Neon', hostClassV1(url) !== 'remote:neon', hostClassV1(url));

  // --- §5/§7 what the driver actually returns ------------------------------
  //
  // Asked rather than assumed. postgres-js maps types by OID and the mapping is
  // a property of the driver and the server, not of the column declaration.
  console.log('\n2. What postgres-js returns for the B20 column types');
  const probe = await client`
    SELECT measured_at, stale_after, created_at, reference_position_atomic,
           largest_passing_size_atomic, observation_block_number, capacity_probe_count,
           capacity_stable, reason_code
    FROM b20_opportunity_observations
    ORDER BY measured_at DESC
    LIMIT 1`;
  const sample = (probe[0] ?? {}) as Record<string, unknown>;
  if (probe.length === 0) {
    record('an observation exists to inspect', false, 'the table is empty');
  } else {
    for (const [column, value] of Object.entries(sample)) {
      console.log(`  ${column.padEnd(28)} ${safeValueCategoryV1(value)}`);
    }
    // §7 — an atomic amount that arrived as a JS number has already lost
    // precision, and no downstream code can put it back.
    const atomics = ['reference_position_atomic', 'largest_passing_size_atomic', 'observation_block_number'];
    const numeric = atomics.filter((column) => typeof sample[column] === 'number');
    record('atomic amounts are not JS numbers', numeric.length === 0, numeric.join(', ') || 'all exact');
  }

  const launchProbe = await client`
    SELECT detected_at, block_timestamp, block_number, decimals
    FROM b20_launches ORDER BY block_number DESC LIMIT 1`;
  for (const [column, value] of Object.entries((launchProbe[0] ?? {}) as Record<string, unknown>)) {
    console.log(`  ${column.padEnd(28)} ${safeValueCategoryV1(value)}`);
  }

  // --- §3 the repository, then the projection, then the schema -------------
  console.log('\n3. The Discover path, stage by stage');
  const observations = createDatabaseB20ObservationRepository(client);
  const now = new Date();

  let counts: Awaited<ReturnType<typeof observations.pipelineCounts>> | undefined;
  try {
    counts = await observations.pipelineCounts({
      now: now.toISOString(),
      maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
    });
    record('repository.pipelineCounts', true, `${counts.canonicalLaunchCount} launches, ${counts.observationCount} observations`);
  } catch (error) {
    record('repository.pipelineCounts', false, error instanceof Error ? error.message : 'unknown');
  }

  try {
    const status = await pipelineStatusV1(observations, now, true);
    record('pipelineStatusV1', true, `${status.state}, ${status.blocksBehind ?? '—'} behind`);
  } catch (error) {
    record('pipelineStatusV1', false, error instanceof Error ? error.message : 'unknown');
  }

  let page: Awaited<ReturnType<typeof observations.listFeed>> | undefined;
  try {
    page = await observations.listFeed({
      limit: 25,
      cursor: null,
      maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
      now: now.toISOString(),
    });
    record('repository.listFeed', true, `${page.rows.length} row(s)`);
  } catch (error) {
    // A throw HERE is a row that could not even be turned into the domain
    // model — the storage boundary, not the schema.
    reportZodV1('repository.listFeed', error, undefined);
  }

  // §6 — the canonical domain model must already be ISO strings and exact
  // strings. Checked on the rows themselves, before any projection.
  if (page) {
    const offenders: string[] = [];
    page.rows.forEach((feedRow, index) => {
      const check = (path: string, value: unknown, want: 'string' | 'string|null'): void => {
        if (value === null && want === 'string|null') return;
        if (typeof value !== 'string') offenders.push(`rows.${index}.${path}=${safeValueCategoryV1(value)}`);
      };
      check('launch.detectedAt', feedRow.launch.detectedAt, 'string');
      check('launch.blockTimestamp', feedRow.launch.blockTimestamp, 'string|null');
      check('launch.blockNumber', feedRow.launch.blockNumber, 'string');
      if (feedRow.observation) {
        check('observation.measuredAt', feedRow.observation.measuredAt, 'string');
        check('observation.staleAfter', feedRow.observation.staleAfter, 'string');
        check('observation.createdAt', feedRow.observation.createdAt, 'string');
        check('observation.referencePositionAtomic', feedRow.observation.referencePositionAtomic, 'string');
        check('observation.largestPassingSizeAtomic', feedRow.observation.largestPassingSizeAtomic, 'string|null');
      }
    });
    record('the domain model is canonical', offenders.length === 0, offenders.slice(0, 6).join(', ') || 'ISO strings and exact amounts');

    // §8 — the states actually present, so the nullability audit runs against
    // real data rather than a fixture.
    const byState = new Map<string, number>();
    for (const feedRow of page.rows) {
      const state = feedRow.observation?.state ?? '(no observation)';
      byState.set(state, (byState.get(state) ?? 0) + 1);
    }
    console.log(`  states in this page: ${[...byState].map(([s, n]) => `${s}=${n}`).join(', ') || 'none'}`);
    const withoutBlockTimestamp = page.rows.filter((feedRow) => feedRow.launch.blockTimestamp === null).length;
    console.log(`  rows without block_timestamp: ${withoutBlockTimestamp}`);
  }

  let feed: Awaited<ReturnType<typeof readDiscoverFeedV1>> | undefined;
  try {
    feed = await readDiscoverFeedV1({ limit: 25, cursor: null, state: 'all', freshness: 'all' });
    record('readDiscoverFeedV1 (card projection)', true, `${feed.cards.length} card(s)`);
  } catch (error) {
    reportZodV1('readDiscoverFeedV1 (card projection)', error, undefined);
  }

  if (feed) {
    try {
      B20OpportunityFeedResponseV1Schema.parse(feed);
      record('B20OpportunityFeedResponseV1Schema.parse', true);
    } catch (error) {
      // THE stage the 500 came from, if the fix is not in yet.
      reportZodV1('B20OpportunityFeedResponseV1Schema.parse', error, feed);
    }
  }

  // --- §9 the other endpoint, for the comparison ---------------------------
  console.log('\n4. Why market rails answers 200 from the same rows');
  try {
    const status = await pipelineStatusV1(observations, now, true);
    const pairs = await observations.listMoverPairs({
      limit: 50,
      now: now.toISOString(),
      baselineAgeMs: 24 * 60 * 60 * 1000,
      baselineToleranceMs: 4 * 60 * 60 * 1000,
      maxLaunchAgeMs: DISCOVER_FEED_WINDOW_MS_V1,
    });
    B20MarketRailsResponseV1Schema.parse({
      pipeline: status,
      capacityLeaders: [],
      movers: [],
      collectingHistory: false,
      toleranceBps: 300,
      moveLabel: '24h change from Miorail measured quotes',
      moveNote: 'Measured by Miorail, not quoted from a market feed.',
      serverTime: now.toISOString(),
    });
    record('rails-shaped response parses', true, `${pairs.length} mover pair(s) available`);
    console.log('  The rails schema contains the pipeline, the leaders and the movers.');
    console.log('  It does NOT contain the cards — so a bad field inside a card is');
    console.log('  invisible to rails and fatal to the feed. Same rows, different');
    console.log('  serialisation surface.');
  } catch (error) {
    reportZodV1('rails-shaped response parses', error, undefined);
  }

  const failed = stages.filter((entry) => !entry.ok);
  console.log('');
  console.log(`${stages.length - failed.length}/${stages.length} stages passed`);
  if (failed.length > 0) {
    console.log(`First failing stage: ${failed[0]!.stage}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    // No DSN, no host, no query text.
    console.error(`doctor failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  });
