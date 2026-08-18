import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { b20PublicContextV1 } from '@mioagent/opportunity-rail';
import type { B20PublicContextCandidateV1 } from '@mioagent/opportunity-rail';

import {
  B20_PUBLIC_PROBE_FETCH_LIMIT_V1,
  linksBackToHostV1,
  linksToHostsV1,
  pageNamesAddressV1,
  probePublicContextV1,
} from '../src/publicProbe.js';
import type { B20HttpFetchV1 } from '../src/collect.js';

// ---------------------------------------------------------------------------
// The probe is what separates a candidate from a ground.
//
// A search ranked a copycat second. Nothing in the ranking distinguishes it
// from the real project — only fetching both and looking for this token's
// address does, and that is what these tests are about.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';

function pages(map: Record<string, string>): { http: B20HttpFetchV1; asked: string[] } {
  const asked: string[] = [];
  const http: B20HttpFetchV1 = async ({ url }) => {
    asked.push(url);
    const body = map[url];
    if (body === undefined) return { ok: false, status: 404, contentType: null, bodyText: '' };
    return { ok: true, status: 200, contentType: 'text/html', bodyText: body };
  };
  return { http, asked };
}

const candidate = (
  kind: B20PublicContextCandidateV1['kind'],
  url: string,
): B20PublicContextCandidateV1 => ({
  kind,
  url,
  host: new URL(url).hostname.replace(/^www\./, ''),
  origin: 'search_result',
  fetched: false,
});

describe('the address test is the whole address', () => {
  test('a page containing it, in any case, names the token', () => {
    assert.equal(pageNamesAddressV1(`buy ${TOKEN.toUpperCase()} now`, TOKEN), true);
    assert.equal(pageNamesAddressV1(`<a href="x">${TOKEN}</a>`, TOKEN), true);
  });

  test('a prefix is not a match, because every B20 shares one', () => {
    // They all begin 0xb2000000…. A prefix test would be met by the whole
    // chain at once.
    assert.equal(pageNamesAddressV1('0xb200000000000000000000', TOKEN), false);
    assert.equal(pageNamesAddressV1(TOKEN.slice(0, -1), TOKEN), false);
  });

  test('a malformed address never matches anything', () => {
    assert.equal(pageNamesAddressV1('anything at all', 'MIO'), false);
    assert.equal(pageNamesAddressV1('', TOKEN), false);
  });
});

describe('links are read as presence, never as meaning', () => {
  test('a link is found wherever it sits in the page', () => {
    const body = '<a href="https://github.com/orbitlab/os">code</a> {"x":"https://x.com/orbitlab"}';
    assert.deepEqual(linksToHostsV1(body, ['github.com']), ['https://github.com/orbitlab/os']);
    assert.deepEqual(linksToHostsV1(body, ['x.com']), ['https://x.com/orbitlab']);
  });

  test('trailing punctuation is not part of the URL', () => {
    assert.deepEqual(linksToHostsV1('see https://orbitlab.xyz/.', ['orbitlab.xyz']), ['https://orbitlab.xyz/']);
  });

  test('a back-link ignores www', () => {
    assert.equal(linksBackToHostV1('go to https://www.orbitlab.xyz/home', 'orbitlab.xyz'), 'https://www.orbitlab.xyz/home');
    assert.equal(linksBackToHostV1('nothing here', 'orbitlab.xyz'), null);
  });
});

describe('the probe tells the real project from the copycat', () => {
  const real = 'https://orbitlab.xyz/';
  const fake = 'https://orbitlab-airdrop.example/';
  const repo = 'https://github.com/orbitlab/os';
  const social = 'https://x.com/orbitlab';

  test('a site naming the address reaches the strongest standing', () => {
    return (async () => {
      const { http } = pages({
        [real]: `<h1>OrbitLab</h1> contract ${TOKEN} <a href="${repo}">github</a> <a href="${social}">x</a>`,
        [repo]: `OrbitLab — see https://orbitlab.xyz for more`,
        [social]: `OrbitLab https://orbitlab.xyz`,
      });
      const evidence = await probePublicContextV1({
        chainId: 8453,
        tokenAddress: TOKEN,
        candidates: [candidate('website', real), candidate('repository', repo), candidate('social', social)],
        deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
      });
      const context = b20PublicContextV1(evidence);
      assert.equal(context.standing, 'names_this_token');
      // And even here it is unverified.
      assert.match(context.headline, /Unverified/);
      assert.ok(evidence.candidates.every((entry) => entry.fetched));
    })();
  });

  test('a copycat that says nothing about the address does not', () => {
    return (async () => {
      const { http } = pages({
        // Same name, same look, no address. Exactly the aerlifi.net case.
        [fake]: `<h1>OrbitLab</h1> claim your airdrop`,
      });
      const evidence = await probePublicContextV1({
        chainId: 8453,
        tokenAddress: TOKEN,
        candidates: [candidate('website', fake)],
        deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
      });
      const context = b20PublicContextV1(evidence);
      assert.equal(context.standing, 'candidates_only');
      assert.equal(
        context.findings.find((finding) => finding.ground === 'page_names_token')!.state,
        'absent',
      );
    })();
  });

  test('a repository naming the address counts when the website did not', () => {
    return (async () => {
      const { http } = pages({
        [real]: `<h1>OrbitLab</h1> <a href="${repo}">github</a>`,
        [repo]: `deployed at ${TOKEN} — https://orbitlab.xyz`,
      });
      const evidence = await probePublicContextV1({
        chainId: 8453,
        tokenAddress: TOKEN,
        candidates: [candidate('website', real), candidate('repository', repo)],
        deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
      });
      assert.equal(evidence.pageNamesToken?.found, true);
      assert.equal(evidence.pageNamesToken?.reference, repo);
    })();
  });

  test('a fetch that did not complete leaves grounds unchecked, never absent', () => {
    return (async () => {
      const { http } = pages({}); // every request 404s
      const evidence = await probePublicContextV1({
        chainId: 8453,
        tokenAddress: TOKEN,
        candidates: [candidate('website', real), candidate('repository', repo)],
        deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
      });
      const context = b20PublicContextV1(evidence);
      // Miorail's own failure must not read as a fact about the project.
      assert.ok(context.findings.every((finding) => finding.state === 'unchecked'));
      assert.equal(context.standing, 'candidates_only');
      assert.ok(evidence.candidates.every((entry) => !entry.fetched));
    })();
  });

  test('back-links are not looked for without a site to point back to', () => {
    return (async () => {
      const { http, asked } = pages({ [repo]: `see https://somewhere.example` });
      const evidence = await probePublicContextV1({
        chainId: 8453,
        tokenAddress: TOKEN,
        candidates: [candidate('repository', repo)],
        deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
      });
      // "Does this repository mention some website" is not a ground.
      assert.equal(asked.length, 0);
      assert.equal(evidence.repositoryLinksSite, null);
    })();
  });

  test('the pass is bounded, so a search cannot spend unbounded requests', () => {
    return (async () => {
      const { http, asked } = pages({});
      await probePublicContextV1({
        chainId: 8453,
        tokenAddress: TOKEN,
        candidates: [
          candidate('website', real),
          candidate('repository', repo),
          candidate('social', social),
        ],
        deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
      });
      assert.ok(asked.length <= B20_PUBLIC_PROBE_FETCH_LIMIT_V1);
    })();
  });
});
