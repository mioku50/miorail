import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { b20PublicContextV1 } from '@mioagent/opportunity-rail';
import type { B20PublicContextCandidateV1 } from '@mioagent/opportunity-rail';

import {
  B20_PUBLIC_PROBE_FETCH_LIMIT_V1,
  candidateFromLinkV1,
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

/** A completed search, which is what most of these fixtures describe. */
const SEARCHED = { kind: 'search' as const, completed: true };

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
        lookup: SEARCHED,
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
        lookup: SEARCHED,
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
        lookup: SEARCHED,
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
        lookup: SEARCHED,
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
        lookup: SEARCHED,
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
        lookup: SEARCHED,
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

// ---------------------------------------------------------------------------
// A named domain, and the accounts the site itself declares.
//
// This is the better evidence of the two. A ranked result is a search engine's
// opinion about which page is the project; a link in the project's own footer
// is the project saying which accounts are theirs. Neither is a link to the
// TOKEN — only the address on the page is that.
// ---------------------------------------------------------------------------
describe('accounts are discovered from the site the reader named', () => {
  const site = 'https://orbitlab.xyz/';
  const repo = 'https://github.com/orbitlab/os';
  const social = 'https://x.com/orbitlab';

  const supplied = {
    kind: 'website' as const,
    url: site,
    host: 'orbitlab.xyz',
    origin: 'operator_supplied' as const,
    fetched: false,
  };

  test('a link in the page becomes a candidate, marked as coming from there', async () => {
    const { http } = pages({
      [site]: `<footer><a href="${repo}">code</a><a href="${social}">x</a></footer> ${TOKEN}`,
      [repo]: `OrbitLab https://orbitlab.xyz`,
      [social]: `OrbitLab https://orbitlab.xyz`,
    });
    const evidence = await probePublicContextV1({
      chainId: 8453,
      tokenAddress: TOKEN,
      lookup: { kind: 'supplied_domain', completed: true, suppliedDomain: 'orbitlab.xyz' },
      candidates: [supplied],
      deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
    });
    assert.deepEqual(
      evidence.candidates.map((c) => `${c.kind}:${c.origin}`),
      ['website:operator_supplied', 'repository:linked_from_website', 'social:linked_from_website'],
    );
    const context = b20PublicContextV1(evidence);
    // The address is on the page, so this is the strongest standing — and it
    // still says Unverified.
    assert.equal(context.standing, 'names_this_token');
    assert.match(context.headline, /Unverified/);
    assert.equal(context.findings.find((f) => f.ground === 'repository_links_site')!.state, 'found');
    assert.equal(context.findings.find((f) => f.ground === 'social_links_site')!.state, 'found');
  });

  test('a named domain that says nothing about the token stays a candidate', async () => {
    // Somebody naming the wrong domain — or a domain that simply has not
    // published the address — must not turn into a link.
    const { http } = pages({ [site]: '<h1>OrbitLab</h1> nothing about any token here' });
    const evidence = await probePublicContextV1({
      chainId: 8453,
      tokenAddress: TOKEN,
      lookup: { kind: 'supplied_domain', completed: true, suppliedDomain: 'orbitlab.xyz' },
      candidates: [supplied],
      deps: { http, now: () => '2026-08-18T10:00:00.000Z' },
    });
    const context = b20PublicContextV1(evidence);
    assert.equal(context.standing, 'candidates_only');
    assert.equal(context.findings.find((f) => f.ground === 'page_names_token')!.state, 'absent');
  });

  test('a link is classified by the same rule a search result is', () => {
    // A footer link to a blog cannot become a "repository" because the site
    // put it there.
    assert.equal(candidateFromLinkV1('https://github.com/orbitlab/os', 'repository')?.origin, 'linked_from_website');
    assert.equal(candidateFromLinkV1('https://orbitlab.substack.com', 'repository'), null);
    assert.equal(candidateFromLinkV1('http://github.com/orbitlab/os', 'repository'), null);
    assert.equal(candidateFromLinkV1('https://x.com/orbitlab', 'social')?.host, 'x.com');
  });
});
