import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  publicProofProviderV1,
  publicProviderNameV1,
  publicSafeSourceKeyV1,
} from './publicProofProvider.js';

function packageFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, relative)
    : path.join(cwd, 'artifacts/api-server', relative);
}

describe('a public proof names the venue that filled the trade', () => {
  test('a derived outcome produces an identity', () => {
    // The gap this closes: `provider: null` was hardcoded at both call sites,
    // so a public artifact never said which venue filled a trade the server
    // knew perfectly well.
    assert.deepEqual(publicProofProviderV1({ outcome: { providerId: 'aerodrome' } }), {
      providerId: 'aerodrome',
      providerName: 'Aerodrome',
      sourceKey: null,
    });
  });

  test('a legacy proof with no outcome stays null, and stays readable', () => {
    // Null keeps meaning "we do not know". An old bundle is not back-filled
    // with a guess.
    assert.equal(publicProofProviderV1({ outcome: null }), null);
  });

  test('an unknown provider id is shown as itself, not hidden', () => {
    const identity = publicProofProviderV1({ outcome: { providerId: 'newvenue' } });
    assert.equal(identity?.providerId, 'newvenue');
    assert.equal(identity?.providerName, 'newvenue');
  });

  test('every known provider has a display name', () => {
    for (const id of ['uniswap', 'kyberswap', 'aerodrome']) {
      assert.notEqual(publicProviderNameV1(id), id, `${id} should have a display name`);
    }
  });
});

describe('a source key is published only when it is provably addresses', () => {
  test('a well-formed Aerodrome key passes through', () => {
    const key = `aerodrome:${'0x' + 'a'.repeat(40)}:${'0x' + 'b'.repeat(40)}:${'0x' + 'c'.repeat(40)}:volatile`;
    assert.equal(publicSafeSourceKeyV1(key), key);
  });

  test('anything else is withheld rather than guessed at', () => {
    // A source key is free-form by contract, and a public bundle is the wrong
    // place to discover what somebody put in one.
    assert.equal(publicSafeSourceKeyV1('uniswap:v3:0.05%:internal-note'), null);
    assert.equal(publicSafeSourceKeyV1('https://api.example/key=SECRET'), null);
    assert.equal(publicSafeSourceKeyV1(null), null);
    assert.equal(publicSafeSourceKeyV1(''), null);
  });

  test('a key with a checksummed address is withheld, because the pattern is exact', () => {
    const key = `aerodrome:${'0x' + 'A'.repeat(40)}:${'0x' + 'b'.repeat(40)}:${'0x' + 'c'.repeat(40)}:volatile`;
    assert.equal(publicSafeSourceKeyV1(key), null);
  });
});

describe('the identity can only come from the server’s own record', () => {
  const route = readFileSync(packageFileV1('routes/publicProof.ts'), 'utf8');

  test('the bundle reads the derived outcome, keyed by proof id', () => {
    assert.match(route, /getProviderOutcomeByProofId/);
    assert.match(route, /never\s*\n?\s*\/\/ from a client/);
  });

  test('the hardcoded null is gone from the route path', () => {
    // It survives for the NFT family, where no outcome is derived — and the
    // comment there says so rather than leaving a bare null.
    assert.ok(!/buildPublicRouteProofBundleV1\(\{ share, provider: null/.test(route));
    assert.match(route, /no derived provider outcome, so this stays null/);
  });

  test('an outcome lookup failure never takes the bundle down with it', () => {
    // A public page that 500s because a statistics table is slow is worse than
    // one that says nothing about the provider.
    assert.match(route, /\.catch\(\(\) => null\)/);
  });
});
