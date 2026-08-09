import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';

import { BASE_MCP_PLUGIN_CATALOGUE_V1 } from '@mioagent/security';

import {
  baseMcpPluginDriftRuntimeV1,
  baseMcpPluginDriftV1,
  resetBaseMcpPluginDriftCacheV1,
} from './baseMcpPluginDrift.js';

const realFetch = baseMcpPluginDriftRuntimeV1.fetchImpl;
const realNow = baseMcpPluginDriftRuntimeV1.now;

function respondWith(names: string[] | null, status = 200) {
  let calls = 0;
  baseMcpPluginDriftRuntimeV1.fetchImpl = (async () => {
    calls += 1;
    if (names === null) throw new Error('fetch failed to https://api.github.com/…?token=secret');
    return new Response(
      JSON.stringify(names.map((name) => ({ name: `${name}.md`, type: 'file' }))),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return () => calls;
}

const knownIds = BASE_MCP_PLUGIN_CATALOGUE_V1.map((plugin) => plugin.id);

beforeEach(() => {
  resetBaseMcpPluginDriftCacheV1();
  delete process.env.BASE_MCP_PLUGIN_DRIFT_CHECK_V1;
});

afterEach(() => {
  baseMcpPluginDriftRuntimeV1.fetchImpl = realFetch;
  baseMcpPluginDriftRuntimeV1.now = realNow;
  resetBaseMcpPluginDriftCacheV1();
  delete process.env.BASE_MCP_PLUGIN_DRIFT_CHECK_V1;
});

describe('drift is measured against what Base publishes, by name only', () => {
  test('the same set is in sync', async () => {
    respondWith(knownIds);
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'in_sync');
    assert.equal(drift.publishedCount, knownIds.length);
    assert.deepEqual(drift.added, []);
    assert.deepEqual(drift.removed, []);
  });

  test('a plugin Base added shows up as added, and is named', async () => {
    respondWith([...knownIds, 'somethingnew']);
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'drifted');
    assert.deepEqual(drift.added, ['somethingnew']);
    assert.equal(drift.publishedCount, knownIds.length + 1);
  });

  test('a plugin Base dropped shows up as removed', async () => {
    respondWith(knownIds.slice(1));
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'drifted');
    assert.deepEqual(drift.removed, [knownIds[0]]);
  });
});

describe('a check that did not run is never a finding about Base', () => {
  test('a transport failure is unchecked, not in sync', async () => {
    respondWith(null);
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'unchecked');
    assert.equal(drift.reason, 'source_unreachable');
    assert.equal(drift.publishedCount, null);
    assert.deepEqual(drift.added, []);
    assert.deepEqual(drift.removed, []);
  });

  test('a non-200 answer is unchecked', async () => {
    baseMcpPluginDriftRuntimeV1.fetchImpl = (async () =>
      new Response('rate limited', { status: 403 })) as typeof fetch;
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'unchecked');
  });

  test('an empty listing is unchecked, not "Base removed every plugin"', async () => {
    // The failure this exists to prevent: our own bad read rendered as a
    // dramatic claim about the subject. Twenty removals is not a plausible
    // reading of a source that answered with nothing.
    respondWith([]);
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'unchecked');
    assert.equal(drift.reason, 'source_empty');
    assert.deepEqual(drift.removed, []);
  });

  test('the known count survives every failure, because it needs no network', async () => {
    respondWith(null);
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.knownCount, knownIds.length);
  });

  test('switching the check off says so rather than implying currency', async () => {
    process.env.BASE_MCP_PLUGIN_DRIFT_CHECK_V1 = 'false';
    let called = false;
    baseMcpPluginDriftRuntimeV1.fetchImpl = (async () => {
      called = true;
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.status, 'unchecked');
    assert.equal(drift.reason, 'check_disabled');
    assert.equal(called, false, 'a disabled check must make no request');
  });
});

describe('the response carries names, never anything a source could inject', () => {
  test('an entry that is not a plain plugin id is dropped', async () => {
    baseMcpPluginDriftRuntimeV1.fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { name: '../../etc/passwd.md', type: 'file' },
          { name: '<script>alert(1)</script>.md', type: 'file' },
          { name: 'Legit-Upper.md', type: 'file' },
          { name: 'realone.md', type: 'file' },
          { name: 'subdir', type: 'dir' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const drift = await baseMcpPluginDriftV1();
    assert.deepEqual(drift.added, ['realone']);
  });

  test('a failure reason is a code, never the transport message', async () => {
    // The thrown message in respondWith carries a URL with a token in it. If
    // that ever reaches the response, a drift indicator has become a leak.
    respondWith(null);
    const drift = await baseMcpPluginDriftV1();
    assert.equal(drift.reason, 'source_unreachable');
    assert.doesNotMatch(JSON.stringify(drift), /github\.com|token|secret/i);
  });
});

describe('the check is cached, so a surface refresh is not a request', () => {
  test('a second call inside the TTL makes no second request', async () => {
    const calls = respondWith(knownIds);
    await baseMcpPluginDriftV1();
    await baseMcpPluginDriftV1();
    assert.equal(calls(), 1);
  });

  test('a failure expires sooner than a success', async () => {
    let clock = 1_000_000;
    baseMcpPluginDriftRuntimeV1.now = () => clock;
    const failures = respondWith(null);
    await baseMcpPluginDriftV1();
    clock += 6 * 60 * 1000;
    await baseMcpPluginDriftV1();
    assert.equal(failures(), 2, 'a five-minute-old failure must be retried');

    resetBaseMcpPluginDriftCacheV1();
    const successes = respondWith(knownIds);
    await baseMcpPluginDriftV1();
    clock += 6 * 60 * 1000;
    await baseMcpPluginDriftV1();
    assert.equal(successes(), 1, 'a fresh success must not be re-fetched');
  });
});
