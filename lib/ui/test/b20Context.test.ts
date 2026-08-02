import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { b20ErrorCodeV1, b20TargetForRouteV1, b20UnavailableCopyV1 } from '../src/console/b20Context';

// ---------------------------------------------------------------------------
// T67E §1. The B20 panels were exported and unit-tested from the day T67C
// landed and NOTHING imported them, so a user comparing a B20 token saw no
// controls at all. These tests cover the wiring that was missing, plus the two
// ways a mounted card can lie: by rendering nothing where a check would appear,
// and by making a switched-off flag look like a passed check.
// ---------------------------------------------------------------------------

const here = path.dirname(url.fileURLToPath(import.meta.url));

describe('which token the card is about', () => {
  test('an ERC-20 the route acquires is the target', () => {
    const target = b20TargetForRouteV1({ address: '0xAbC', symbol: 'USDC' });
    assert.equal(target.address, '0xAbC');
    assert.equal(target.skipReason, null);
  });

  test('the native asset has nothing to inspect, and says so', () => {
    // A missing panel where one usually appears reads as a failed check.
    const target = b20TargetForRouteV1({ address: null, symbol: 'ETH' });
    assert.equal(target.address, null);
    assert.match(target.skipReason!, /native asset, so it has no token contract/);
  });

  test('no route at all produces no target and no reason', () => {
    // Nothing was attempted; there is nothing to explain.
    assert.deepEqual(b20TargetForRouteV1(null), { address: null, symbol: null, skipReason: null });
  });
});

describe('why there is no card', () => {
  const base = { gateEnabled: true, skipReason: null, errorCode: null };

  test('a switched-off gate never reads as a passed check', () => {
    const copy = b20UnavailableCopyV1({ ...base, gateEnabled: false });
    assert.match(copy!, /is off on this server/);
    // The one thing this must never imply.
    assert.ok(!/safe|no restrictions|clear/i.test(copy!), copy!);
  });

  test('every refusal is a different sentence', () => {
    // Collapsing these is how a missing RPC ends up looking like a token that
    // passed inspection.
    const seen = new Set<string>();
    for (const errorCode of [
      'b20_rpc_unavailable',
      'b20_rpc_no_answer',
      'b20_storage_unavailable',
      'invalid_b20_inspect_request',
      'authentication_required',
    ]) {
      const copy = b20UnavailableCopyV1({ ...base, errorCode });
      assert.ok(copy, errorCode);
      assert.ok(!seen.has(copy), `${errorCode} reuses another reason's words`);
      seen.add(copy);
    }
  });

  test('an infrastructure refusal says what still works', () => {
    assert.match(
      b20UnavailableCopyV1({ ...base, errorCode: 'b20_rpc_unavailable' })!,
      /Route comparison still works/,
    );
  });

  test('a skip reason wins over everything', () => {
    const copy = b20UnavailableCopyV1({
      gateEnabled: false,
      skipReason: 'ETH is the chain’s native asset.',
      errorCode: 'b20_rpc_unavailable',
    });
    assert.equal(copy, 'ETH is the chain’s native asset.');
  });

  test('a successful read leaves nothing to say', () => {
    assert.equal(b20UnavailableCopyV1(base), null);
  });
});

describe('an error never carries an endpoint', () => {
  test('only known codes survive; anything else is generic', () => {
    // T67C §5: an RPC error can carry the endpoint URL, and the endpoint URL
    // can carry the key. Nothing from the message is echoed.
    const leak = new Error('fetch failed https://base-mainnet.g.alchemy.com/v2/SECRETKEY');
    const code = b20ErrorCodeV1(leak);
    assert.equal(code, 'b20_unavailable');
    assert.ok(!code!.includes('SECRET'));
    assert.ok(!code!.includes('alchemy'));
  });

  test('a known code is recognised', () => {
    assert.equal(b20ErrorCodeV1(new Error('503: b20_rpc_unavailable')), 'b20_rpc_unavailable');
  });

  test('a configured endpoint that went quiet is not the same code as no endpoint', () => {
    // One is an operator's problem, the other is worth retrying. A user sent to
    // the wrong one gives up on a working install, or waits on a broken one.
    assert.equal(b20ErrorCodeV1(new Error('503: b20_rpc_no_answer')), 'b20_rpc_no_answer');
  });

  test('no error is no code', () => {
    assert.equal(b20ErrorCodeV1(null), null);
  });
});

describe('the panels are actually mounted', () => {
  // The defect this whole section exists for: B20Panels.tsx was exported from
  // the barrel, covered by b20Panels.test.tsx, and imported by nothing.
  for (const [surface, file] of [
    ['web console', '../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx'],
    ['miniapp console', '../../../artifacts/miniapp/app/components/MiniConsole.tsx'],
  ] as const) {
    test(`${surface} renders the B20 control section`, () => {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.ok(source.includes('B20ControlSection'), `${surface} does not mount the panel`);
      assert.ok(source.includes('useB20Inspect'), `${surface} never inspects a token`);
      // Route AND Review: the Route screen is where a user decides, and Review
      // is the last screen before a signature.
      assert.ok(source.includes('b20Panels(true)'), `${surface} omits the detailed card on Review`);
      assert.ok(source.includes('b20Panels(false)'), `${surface} omits the card on Route`);
    });
  }
});
