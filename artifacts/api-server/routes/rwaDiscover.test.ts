import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import {
  LOOKALIKE_DISCLAIMER_V1,
  type OfficialAssetsOverviewV1,
  type OfficialLookalikeFeedV1,
  type RwaSignalFeedV1,
} from '@mioagent/rwa-dossier';

import { rwaDiscoverRouter, rwaDiscoverRuntime } from './rwaDiscover.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const originalRuntime = { ...rwaDiscoverRuntime };

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', rwaDiscoverRouter);
  return server;
}

afterEach(() => {
  Object.assign(rwaDiscoverRuntime, originalRuntime);
});

beforeEach(() => {
  rwaDiscoverRuntime.enabled = () => true;
  rwaDiscoverRuntime.migrationAvailable = async () => true;
  // The deps are never reached in these tests: every case replaces the
  // assembler. A stub that throws proves that.
  rwaDiscoverRuntime.deps = () => {
    throw new Error('these tests must not open a database connection');
  };
});

const OVERVIEW_V1: OfficialAssetsOverviewV1 = {
  schemaVersion: 'official-assets-overview/v1' as const,
  chainId: 8453 as const,
  observedAt: '2026-08-25T12:00:00.000Z',
  counts: {
    officialIssuance: 1,
    cashRouteEstablished: 1,
    noRouteAtMeasuredSizes: 0,
    noEntryRouteAtMeasuredSizes: 0,
    measurementFailed: 0,
    notMeasured: 0,
  },
  sources: [
    {
      sourceKind: 'base_docs_technical' as const,
      sourceUrl: 'https://docs.base.org/x.md',
      checkedAt: '2026-08-25T11:00:00.000Z',
      status: 'ok' as const,
      assetCount: 1,
      lastSuccessfulAt: '2026-08-25T11:00:00.000Z',
    },
  ],
  marketObservation: { status: 'never_run' as const, checkedThroughBlock: null, checkedAt: null },
  assets: [],
  gaps: [],
};

describe('GET the official assets overview', () => {
  test('inherits the route-intelligence gate before session or storage', async () => {
    rwaDiscoverRuntime.enabled = () => false;
    rwaDiscoverRuntime.migrationAvailable = async () => {
      throw new Error('a disabled route must stop first');
    };
    const response = await request(app(null)).get('/api/route-intelligence/rwa/official/assets');
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'route_intelligence_disabled');
  });

  test('requires a valid Base tenant session before touching storage', async () => {
    rwaDiscoverRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get('/api/route-intelligence/rwa/official/assets');
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('a database without the Phase 6 tables is a refusal, not an empty corpus', async () => {
    // The failure this prevents: a half-migrated server answering "0 official
    // assets", which reads as a finding about Coinbase rather than about us.
    rwaDiscoverRuntime.migrationAvailable = async () => false;
    const response = await request(app()).get('/api/route-intelligence/rwa/official/assets');
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'rwa_discover_storage_unavailable');
  });

  test('serves the overview and bounds the limit', async () => {
    let seen = -1;
    rwaDiscoverRuntime.deps = () => ({}) as never;
    rwaDiscoverRuntime.overview = async (_deps, input) => {
      seen = input?.limit ?? -1;
      return OVERVIEW_V1;
    };
    const response = await request(app()).get(
      '/api/route-intelligence/rwa/official/assets?limit=9999',
    );
    assert.equal(response.status, 200);
    assert.equal(seen, 64);
    assert.equal(response.body.counts.officialIssuance, 1);
  });

  test('an assembler failure never forwards the upstream message', async () => {
    rwaDiscoverRuntime.deps = () => ({}) as never;
    rwaDiscoverRuntime.overview = async () => {
      // A provider error can carry an endpoint, and an endpoint can carry a key.
      throw new Error('connect ECONNREFUSED postgres://user:secret@10.0.0.4:5432');
    };
    const response = await request(app()).get('/api/route-intelligence/rwa/official/assets');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'official_assets_overview_failed');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
    assert.equal(JSON.stringify(response.body).includes('10.0.0.4'), false);
  });
});

describe('GET the lookalike feed', () => {
  const FEED_V1: OfficialLookalikeFeedV1 = {
    schemaVersion: 'official-lookalike-feed/v1' as const,
    chainId: 8453 as const,
    observedAt: '2026-08-25T12:00:00.000Z',
    // The constant itself, not a copy: the sentence is code-owned so no
    // surface and no test can soften it or sharpen it into an accusation.
    disclaimer: LOOKALIKE_DISCLAIMER_V1,
    counts: { total: 112, publishedTicker: 12, underlying: 95, displayName: 5 },
    filteredBy: null,
    lastScanAt: '2026-08-25T11:00:00.000Z',
    cards: [],
  };

  test('an unknown spelling is refused rather than silently serving everything', async () => {
    // Serving all 112 for a filter the caller believed in would put "Published
    // ticker" above 95 contracts wearing an ordinary English word.
    rwaDiscoverRuntime.lookalikes = async () => {
      throw new Error('validation must stop first');
    };
    const response = await request(app()).get(
      '/api/route-intelligence/rwa/lookalikes?alias=looks_dodgy',
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'unknown_alias_filter');
  });

  test('a known spelling reaches the projection, and no filter means null', async () => {
    const seen: (string | null)[] = [];
    rwaDiscoverRuntime.deps = () => ({}) as never;
    rwaDiscoverRuntime.lookalikes = async (_deps, input) => {
      seen.push(input?.matchedAlias ?? null);
      return { ...FEED_V1, filteredBy: input?.matchedAlias ?? null };
    };
    const filtered = await request(app()).get(
      '/api/route-intelligence/rwa/lookalikes?alias=published_ticker',
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.filteredBy, 'published_ticker');
    // The counts describe the corpus, never the filtered page.
    assert.equal(filtered.body.counts.total, 112);

    const unfiltered = await request(app()).get('/api/route-intelligence/rwa/lookalikes');
    assert.equal(unfiltered.body.filteredBy, null);
    assert.deepEqual(seen, ['published_ticker', null]);
  });
});

describe('GET the signal feed', () => {
  test('publishes what is being watched, so an empty feed can be read', async () => {
    rwaDiscoverRuntime.deps = () => ({}) as never;
    rwaDiscoverRuntime.signals = async (): Promise<RwaSignalFeedV1> => ({
      schemaVersion: 'rwa-signal-feed/v1' as const,
      chainId: 8453 as const,
      observedAt: '2026-08-25T12:00:00.000Z',
      watching: [
        {
          kind: 'official_asset_lookalike_created' as const,
          watchingSince: '2026-08-25T10:00:00.000Z',
        },
      ],
      notReported: ['Trades.'],
      cards: [],
    });
    const response = await request(app()).get('/api/route-intelligence/rwa/signals');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.cards, []);
    // Without this, "no signals" and "nothing has ever been watched" are the
    // same empty list and opposite facts.
    assert.equal(response.body.watching[0].watchingSince, '2026-08-25T10:00:00.000Z');
    assert.deepEqual(response.body.notReported, ['Trades.']);
  });

  test('a signal feed failure is a stable code', async () => {
    rwaDiscoverRuntime.deps = () => ({}) as never;
    rwaDiscoverRuntime.signals = async () => {
      throw new Error('postgres://user:secret@10.0.0.4:5432 refused');
    };
    const response = await request(app()).get('/api/route-intelligence/rwa/signals');
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'rwa_signal_feed_failed');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});
