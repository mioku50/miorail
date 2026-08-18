import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  B20_FUNDAMENTAL_STANDINGS_V1,
  B20_PUBLIC_CONTEXT_DISCLAIMER_V1,
  B20_PUBLIC_CONTEXT_GROUNDS_V1,
  B20_PUBLIC_CONTEXT_STANDINGS_V1,
  b20PublicContextV1,
  type B20PublicContextEvidenceV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The layer exists to say "possible" without ever saying "verified".
//
// Two failures would make it worse than not shipping it: a candidate reaching
// the verified standings, and a card whose grounds read as substantiation when
// they are true of most of the chain.
// ---------------------------------------------------------------------------

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';

function evidence(over: Partial<B20PublicContextEvidenceV1> = {}): B20PublicContextEvidenceV1 {
  return {
    chainId: 8453,
    tokenAddress: TOKEN,
    candidates: [],
    pageNamesToken: null,
    siteLinksRepository: null,
    repositoryLinksSite: null,
    siteLinksSocial: null,
    socialLinksSite: null,
    observedAt: '2026-08-18T10:00:00.000Z',
    ...over,
  };
}

const candidate = (kind: 'website' | 'repository' | 'social', host: string) => ({
  kind,
  url: `https://${host}/`,
  host,
  origin: 'search_result' as const,
  fetched: true,
});

describe('a candidate can never become a verified project', () => {
  test('the two standing vocabularies do not overlap', () => {
    for (const standing of B20_PUBLIC_CONTEXT_STANDINGS_V1) {
      assert.ok(
        !(B20_FUNDAMENTAL_STANDINGS_V1 as readonly string[]).includes(standing),
        `"${standing}" is a word both layers use`,
      );
    }
  });

  test('the strongest possible evidence still produces an unverified standing', () => {
    // Every ground found at once: the page names the token, and both link
    // pairs close. This is as far as this layer can ever go.
    const context = b20PublicContextV1(
      evidence({
        candidates: [candidate('website', 'orbitlab.xyz'), candidate('repository', 'github.com'), candidate('social', 'x.com')],
        pageNamesToken: { found: true, reference: 'https://orbitlab.xyz/' },
        siteLinksRepository: { found: true, reference: 'https://github.com/orbitlab/os' },
        repositoryLinksSite: { found: true, reference: 'https://orbitlab.xyz' },
        siteLinksSocial: { found: true, reference: 'https://x.com/orbitlab' },
        socialLinksSite: { found: true, reference: 'https://orbitlab.xyz' },
      }),
    );
    assert.equal(context.standing, 'names_this_token');
    assert.match(context.headline, /Unverified/);
    assert.ok(!/verified project/i.test(context.headline));
    assert.ok(!/product.backed/i.test(JSON.stringify(context)));
  });

  test('the module cannot even name a fundamental standing', () => {
    // Structural, not a convention: there is no import, no literal and no
    // branch by which a candidate could be filed under the verified layer.
    const source = readFileSync(new URL('../src/publicContext.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const banned of ['product_backed', 'verified_project', 'B20FundamentalStandingV1', 'identityVerified']) {
      assert.ok(!code.includes(banned), `publicContext.ts references "${banned}"`);
    }
  });
});

describe('name and symbol are not grounds, because on this chain they are not evidence', () => {
  test('no ground is about the launch name or symbol matching something', () => {
    // Measured 2026-08-17: 61.7% of 33,541 canonical launches share their
    // symbol with another launch; 950 of them are called `b20`, 899 are named
    // `my token`. A tick for "the name matches" would be true of most of the
    // chain and would read as substantiation.
    //
    // `page_names_token` is the opposite direction and is the point of the
    // layer: a page naming this ADDRESS is the project saying something about
    // this launch. It is not a name match.
    for (const banned of ['exact_name_match', 'exact_symbol_match', 'name_match', 'symbol_match', 'ticker_match']) {
      assert.ok(
        !(B20_PUBLIC_CONTEXT_GROUNDS_V1 as readonly string[]).includes(banned),
        `"${banned}" is a ground`,
      );
    }
    for (const ground of B20_PUBLIC_CONTEXT_GROUNDS_V1) {
      assert.ok(!/match/i.test(ground), `"${ground}" establishes a match rather than a link`);
    }
  });

  test('the grounds list is exactly the five things Miorail can read', () => {
    assert.deepEqual(
      [...B20_PUBLIC_CONTEXT_GROUNDS_V1],
      ['page_names_token', 'site_links_repository', 'repository_links_site', 'site_links_social', 'social_links_site'],
    );
  });
});

describe('every ground is shown, checked or not', () => {
  test('an empty pass still lists all five, as unchecked', () => {
    const context = b20PublicContextV1(evidence());
    assert.equal(context.findings.length, B20_PUBLIC_CONTEXT_GROUNDS_V1.length);
    assert.ok(context.findings.every((finding) => finding.state === 'unchecked'));
    // Three ticks with no denominator reads as "everything matched".
    assert.deepEqual(
      context.findings.map((finding) => finding.ground),
      [...B20_PUBLIC_CONTEXT_GROUNDS_V1],
    );
  });

  test('absent and unchecked stay different facts', () => {
    const context = b20PublicContextV1(
      evidence({
        candidates: [candidate('website', 'orbitlab.xyz')],
        pageNamesToken: { found: false, reference: 'https://orbitlab.xyz/' },
      }),
    );
    const names = context.findings.find((finding) => finding.ground === 'page_names_token')!;
    const back = context.findings.find((finding) => finding.ground === 'repository_links_site')!;
    assert.equal(names.state, 'absent');
    assert.match(names.note, /fetched the page and it does not contain/);
    assert.equal(back.state, 'unchecked');
    assert.match(back.note, /No repository was fetched/);
  });
});

describe('a linked cluster is not a link to the token', () => {
  test('mutual links alone say so in words', () => {
    const context = b20PublicContextV1(
      evidence({
        candidates: [candidate('website', 'orbitlab.xyz'), candidate('repository', 'github.com')],
        pageNamesToken: { found: false, reference: 'https://orbitlab.xyz/' },
        siteLinksRepository: { found: true, reference: 'https://github.com/orbitlab/os' },
        repositoryLinksSite: { found: true, reference: 'https://orbitlab.xyz' },
      }),
    );
    assert.equal(context.standing, 'linked_cluster');
    assert.match(context.detail, /not evidence that the project has anything to do with this token/);
    assert.match(context.detail, /none of them mentions this address/);
  });

  test('one direction is not a cluster', () => {
    // Anyone can link to somebody else's repository from their own page.
    const context = b20PublicContextV1(
      evidence({
        candidates: [candidate('website', 'copy.example')],
        siteLinksRepository: { found: true, reference: 'https://github.com/real/project' },
        repositoryLinksSite: { found: false, reference: null },
      }),
    );
    assert.equal(context.standing, 'candidates_only');
  });
});

describe('the card never overstates what a search returned', () => {
  test('nothing found is about the search, not about the token', () => {
    const context = b20PublicContextV1(evidence());
    assert.equal(context.standing, 'nothing_found');
    assert.match(context.detail, /statement about the search, not about the token/);
  });

  test('candidates with no ground established say they are search results and nothing more', () => {
    const context = b20PublicContextV1(
      evidence({ candidates: [candidate('website', 'maybe.example'), candidate('social', 'x.com')] }),
    );
    assert.equal(context.standing, 'candidates_only');
    assert.match(context.detail, /search results and nothing more/);
    assert.match(context.detail, new RegExp(B20_PUBLIC_CONTEXT_DISCLAIMER_V1.slice(0, 60)));
  });

  test('no card carries a score, a percentage or a confidence', () => {
    const contexts = [
      b20PublicContextV1(evidence()),
      b20PublicContextV1(evidence({ candidates: [candidate('website', 'a.example')] })),
      b20PublicContextV1(
        evidence({
          candidates: [candidate('website', 'a.example')],
          pageNamesToken: { found: true, reference: 'https://a.example/' },
        }),
      ),
    ];
    const rendered = JSON.stringify(contexts);
    for (const banned of ['confidence', 'match score', '%', 'likely', 'probably', 'official']) {
      assert.ok(!new RegExp(banned, 'i').test(rendered), `a public-context card says "${banned}"`);
    }
  });

  test('the disclaimer names the thing a reader is most likely to assume', () => {
    assert.match(B20_PUBLIC_CONTEXT_DISCLAIMER_V1, /Sharing a name or a symbol with a known project is not a link/);
  });
});
