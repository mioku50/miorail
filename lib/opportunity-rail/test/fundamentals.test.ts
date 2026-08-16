import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_FUNDAMENTAL_COPY_V1,
  B20_FUNDAMENTAL_DIMENSIONS_V1,
  B20_PROJECT_FILTERS_V1,
  b20FundamentalProfileFromStoredV1,
  fundamentalCopyKeyV1,
  b20ClaimStandingV1,
  b20FundamentalProfileV1,
  b20ProjectFilterMatchesV1,
  type B20FundamentalEvidenceV1,
  type B20FundamentalProfileV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The question this layer answers is "is there a real project behind this
// token", and the only way to answer it wrongly is to attach somebody's project
// to somebody else's token. Every test here is a way that could happen.
// ---------------------------------------------------------------------------

const NOW = '2026-08-16T12:00:00.000Z';

const VERIFIED_CLAIM = b20ClaimStandingV1({
  claimantDomain: 'miorail.xyz',
  status: 'verified',
  verifiedLinks: ['launch_sender', 'domain_file', 'project_publication'],
  refutedLinks: [],
  lastCheckedAt: '2026-08-16T11:00:00.000Z',
});

const NO_CLAIM = b20ClaimStandingV1(null);

function evidence(over: Partial<B20FundamentalEvidenceV1> = {}): B20FundamentalEvidenceV1 {
  return {
    claim: VERIFIED_CLAIM,
    claimantDomain: 'miorail.xyz',
    website: null,
    product: null,
    docs: null,
    repository: null,
    basePresence: null,
    launchedAt: null,
    now: NOW,
    ...over,
  };
}

const find = (profile: B20FundamentalProfileV1, dimension: string) =>
  profile.findings.find((finding) => finding.dimension === dimension);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('nothing attaches to a token whose identity was not proven', () => {
  test('an unclaimed token has NO findings, not a column of unknowns', () => {
    const profile = b20FundamentalProfileV1(evidence({ claim: NO_CLAIM, claimantDomain: null }));
    assert.equal(profile.identityVerified, false);
    assert.equal(profile.standing, 'unverified');
    assert.equal(profile.findings.length, 0);
    assert.equal(profile.projectDomain, null);
    assert.match(profile.headline, /Unverified/);
  });

  test('an unclaimed token is the ordinary case, and the copy says so', () => {
    const profile = b20FundamentalProfileV1(evidence({ claim: NO_CLAIM, claimantDomain: null }));
    assert.match(profile.detail, /most launches are never claimed/i);
    assert.match(profile.detail, /ordinary case rather than a warning/i);
  });

  test('a token that merely shares a symbol inherits nothing', () => {
    // The failure this layer exists to prevent. Evidence about a real project
    // is present in the input and the claim is absent — which is exactly the
    // shape of a copycat launch — and not one field of it survives.
    const impostor = b20FundamentalProfileV1(
      evidence({
        claim: NO_CLAIM,
        claimantDomain: null,
        website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW },
        product: { url: 'https://miorail.xyz/mcp', reachable: true, functional: true, observedAt: NOW },
        repository: {
          url: 'https://github.com/mioku50/mioagent',
          createdAt: '2025-01-01T00:00:00.000Z',
          lastCommitAt: NOW,
          observedAt: NOW,
        },
      }),
    );
    assert.equal(impostor.findings.length, 0);
    assert.equal(impostor.standing, 'unverified');
    assert.equal(impostor.projectDomain, null);
    const surface = `${impostor.headline} ${impostor.detail}`;
    assert.ok(!/miorail\.xyz/.test(surface), 'an unproven token was shown a project domain');
    assert.ok(!/github/i.test(surface), 'an unproven token was shown a repository');
  });

  test('a refuted claim says the claim failed, never that the token did', () => {
    const refuted = b20ClaimStandingV1({
      claimantDomain: 'example.org',
      status: 'refuted',
      verifiedLinks: [],
      refutedLinks: ['domain_file'],
      lastCheckedAt: NOW,
    });
    const profile = b20FundamentalProfileV1(evidence({ claim: refuted, claimantDomain: 'example.org' }));
    assert.equal(profile.identityVerified, false);
    assert.equal(profile.findings.length, 0);
    assert.match(profile.detail, /statement about that claim, not about the token/i);
  });

  test('an unverified claim does not open the gate either', () => {
    const pending = b20ClaimStandingV1({
      claimantDomain: 'example.org',
      status: 'unverified',
      verifiedLinks: [],
      refutedLinks: [],
      lastCheckedAt: NOW,
    });
    assert.equal(
      b20FundamentalProfileV1(evidence({ claim: pending, claimantDomain: 'example.org' })).identityVerified,
      false,
    );
  });

  test('a verified claim with no domain is not a verified identity', () => {
    // Defence in depth: the domain is what everything below hangs off, so a
    // status without one may not open the gate.
    assert.equal(b20FundamentalProfileV1(evidence({ claimantDomain: null })).identityVerified, false);
  });
});

// ---------------------------------------------------------------------------
// A website is not a product
// ---------------------------------------------------------------------------

describe('a page that renders is not a product that runs', () => {
  test('a reachable landing page reaches `found`, never `live`', () => {
    const profile = b20FundamentalProfileV1(
      evidence({
        website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW },
        product: { url: 'https://miorail.xyz/app', reachable: true, functional: false, observedAt: NOW },
      }),
    );
    assert.equal(find(profile, 'product')?.state, 'found');
    assert.equal(profile.standing, 'verified_project');
    assert.match(find(profile, 'product')?.note ?? '', /page that exists rather than a product shown to run/i);
  });

  test('an endpoint that answered a real request reaches `live`', () => {
    const profile = b20FundamentalProfileV1(
      evidence({
        product: { url: 'https://miorail.xyz/mcp', reachable: true, functional: true, observedAt: NOW },
      }),
    );
    assert.equal(find(profile, 'product')?.state, 'live');
    assert.equal(find(profile, 'product')?.provenance, 'functional_probe');
    assert.equal(profile.standing, 'product_backed');
    // And the strongest standing still refuses to say the product is good.
    assert.match(find(profile, 'product')?.note ?? '', /not that it is useful, correct, safe or maintained/i);
  });

  test('a website alone never reaches the product-backed standing', () => {
    const profile = b20FundamentalProfileV1(
      evidence({ website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW } }),
    );
    assert.equal(find(profile, 'website')?.state, 'verified');
    assert.equal(profile.standing, 'verified_project');
    assert.equal(find(profile, 'product'), undefined);
    assert.ok(profile.missing.includes('product'));
  });

  test('an unreachable site is not evidence the project is gone', () => {
    const profile = b20FundamentalProfileV1(
      evidence({ website: { url: 'https://miorail.xyz', reachable: false, observedAt: NOW } }),
    );
    assert.equal(find(profile, 'website')?.state, 'unverified');
    assert.match(find(profile, 'website')?.note ?? '', /not evidence that the project is gone/i);
  });

  test('a declared product that did not answer is unknown, not absent', () => {
    const profile = b20FundamentalProfileV1(
      evidence({
        product: { url: 'https://miorail.xyz/mcp', reachable: false, functional: false, observedAt: NOW },
      }),
    );
    assert.equal(find(profile, 'product')?.state, 'unknown');
    assert.match(find(profile, 'product')?.note ?? '', /nothing from that in either direction/i);
  });
});

// ---------------------------------------------------------------------------
// A repository is not development
// ---------------------------------------------------------------------------

describe('existing and moving are separate answers', () => {
  const repo = (over: Record<string, unknown> = {}) => ({
    url: 'https://github.com/mioku50/mioagent',
    createdAt: '2025-03-01T00:00:00.000Z',
    lastCommitAt: '2026-08-15T00:00:00.000Z',
    observedAt: NOW,
    ...over,
  });

  test('a repository with a recent commit is active in both dimensions', () => {
    const profile = b20FundamentalProfileV1(evidence({ repository: repo() }));
    assert.equal(find(profile, 'repository')?.state, 'active');
    assert.equal(find(profile, 'development_activity')?.state, 'active');
  });

  test('a repository with no commit read is `found`, and activity stays unknown', () => {
    // The exact place `unknown` would become `no` if nobody was careful: a
    // repository whose last commit was never read is not a quiet repository.
    const profile = b20FundamentalProfileV1(evidence({ repository: repo({ lastCommitAt: null }) }));
    assert.equal(find(profile, 'repository')?.state, 'found');
    assert.equal(find(profile, 'development_activity'), undefined);
    assert.ok(profile.missing.includes('development_activity'));
    assert.match(find(profile, 'repository')?.note ?? '', /not the same as establishing that there is none/i);
  });

  test('an old last commit is quiet, and quiet is not abandoned', () => {
    const profile = b20FundamentalProfileV1(
      evidence({ repository: repo({ lastCommitAt: '2026-01-01T00:00:00.000Z' }) }),
    );
    assert.equal(find(profile, 'development_activity')?.state, 'quiet');
    assert.equal(find(profile, 'repository')?.state, 'found');
    assert.match(find(profile, 'development_activity')?.note ?? '', /Quiet is not abandoned/i);
  });

  test('no commit count appears anywhere on the profile', () => {
    // A commit total is a quality score with a technical name, and the
    // evidence type has no field to carry one.
    const profile = b20FundamentalProfileV1(evidence({ repository: repo() }));
    const surface = JSON.stringify(profile);
    assert.ok(!/commitCount|commits":\s*\d|\d+ commits/i.test(surface), 'a commit count reached the profile');
  });
});

// ---------------------------------------------------------------------------
// Before the token
// ---------------------------------------------------------------------------

describe('project before token needs two real dates', () => {
  test('a repository older than the launch says yes', () => {
    const profile = b20FundamentalProfileV1(
      evidence({
        repository: {
          url: 'https://github.com/mioku50/mioagent',
          createdAt: '2025-03-01T00:00:00.000Z',
          lastCommitAt: '2026-08-15T00:00:00.000Z',
          observedAt: NOW,
        },
        launchedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    assert.equal(find(profile, 'project_before_token')?.state, 'yes');
    assert.equal(find(profile, 'project_before_token')?.provenance, 'timestamp_comparison');
    assert.match(find(profile, 'project_before_token')?.note ?? '', /not that the token was part of it/i);
  });

  test('a repository created after the launch says no, and says only that', () => {
    // The ONE dimension allowed to reach `no`, because it is a comparison of
    // two timestamps Miorail actually holds.
    const profile = b20FundamentalProfileV1(
      evidence({
        repository: {
          url: 'https://github.com/x/y',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastCommitAt: null,
          observedAt: NOW,
        },
        launchedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    assert.equal(find(profile, 'project_before_token')?.state, 'no');
    assert.match(find(profile, 'project_before_token')?.note ?? '', /a project may predate any repository/i);
  });

  test('an unknown launch time keeps it unknown however old the repository is', () => {
    const profile = b20FundamentalProfileV1(
      evidence({
        repository: {
          url: 'https://github.com/x/y',
          createdAt: '2020-01-01T00:00:00.000Z',
          lastCommitAt: null,
          observedAt: NOW,
        },
        launchedAt: null,
      }),
    );
    assert.equal(find(profile, 'project_before_token'), undefined);
    assert.ok(profile.missing.includes('project_before_token'));
  });

  test('a repository with no creation date keeps it unknown', () => {
    const profile = b20FundamentalProfileV1(
      evidence({
        repository: { url: 'https://github.com/x/y', createdAt: null, lastCommitAt: null, observedAt: NOW },
        launchedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    assert.equal(find(profile, 'project_before_token'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Properties that hold across every input
// ---------------------------------------------------------------------------

describe('the properties that must hold whatever the evidence says', () => {
  const ALL = evidence({
    website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW },
    product: { url: 'https://miorail.xyz/mcp', reachable: true, functional: true, observedAt: NOW },
    docs: { url: 'https://miorail.xyz/docs', reachable: true, observedAt: NOW },
    repository: {
      url: 'https://github.com/mioku50/mioagent',
      createdAt: '2025-03-01T00:00:00.000Z',
      lastCommitAt: '2026-08-15T00:00:00.000Z',
      observedAt: NOW,
    },
    basePresence: { kind: 'mcp_endpoint', reference: 'https://miorail.xyz/mcp', observedAt: NOW },
    launchedAt: '2026-07-01T00:00:00.000Z',
  });

  test('every finding carries a provenance and a time', () => {
    const profile = b20FundamentalProfileV1(ALL);
    assert.equal(profile.findings.length, B20_FUNDAMENTAL_DIMENSIONS_V1.length);
    for (const finding of profile.findings) {
      assert.ok(finding.provenance !== 'not_collected', `${finding.dimension} has no provenance`);
      assert.ok(finding.observedAt, `${finding.dimension} has no timestamp`);
      assert.ok(finding.note.length > 0, `${finding.dimension} claims something with no bound on it`);
    }
    assert.deepEqual(profile.missing, []);
  });

  test('no investment vocabulary reaches any string on the profile', () => {
    for (const input of [ALL, evidence(), evidence({ claim: NO_CLAIM, claimantDomain: null })]) {
      const profile = b20FundamentalProfileV1(input);
      const surface = [
        profile.headline,
        profile.detail,
        ...profile.findings.flatMap((finding) => [finding.label, finding.note]),
      ]
        .join(' ')
        .toLowerCase()
        // The product note legitimately contains "safe" — in the sentence
        // denying it. Scan everything except the denial itself.
        .replaceAll('not that it is useful, correct, safe or maintained', '');
      for (const banned of [
        'promising', 'bullish', 'good buy', 'safe', 'high potential', 'legit', 'trustworthy',
        'score', 'rating', 'recommend', 'invest', 'undervalued', 'gem',
      ]) {
        assert.ok(!surface.includes(banned), `the profile says "${banned}"`);
      }
    }
  });

  test('there is no number on the profile a caller could sort by', () => {
    // No score means no field that adds up. The findings are states with
    // words; the only counts anywhere are the claim's own `1 of 3` fraction.
    const profile = b20FundamentalProfileV1(ALL) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(profile)) {
      assert.notEqual(typeof value, 'number', `the profile exposes a sortable number at "${key}"`);
    }
    for (const finding of b20FundamentalProfileV1(ALL).findings) {
      for (const [key, value] of Object.entries(finding)) {
        assert.notEqual(typeof value, 'number', `a finding exposes a sortable number at "${key}"`);
      }
    }
  });

  test('a verified identity with nothing else collected is still a valid profile', () => {
    const profile = b20FundamentalProfileV1(evidence());
    assert.equal(profile.identityVerified, true);
    assert.equal(profile.standing, 'verified_project');
    assert.equal(profile.findings.length, 1);
    assert.equal(profile.findings[0]!.dimension, 'project_identity');
    // Everything else is named as missing rather than silently absent.
    assert.equal(profile.missing.length, B20_FUNDAMENTAL_DIMENSIONS_V1.length - 1);
  });

  test('the identity finding never overstates what a claim proves', () => {
    const profile = b20FundamentalProfileV1(evidence());
    assert.match(
      profile.findings[0]!.note,
      /did not review the project, its team or its code/i,
    );
  });
});

describe('the Discover filter', () => {
  test('verified project includes product-backed, and unknown is its own bucket', () => {
    assert.equal(b20ProjectFilterMatchesV1('verified_project', 'product_backed'), true);
    assert.equal(b20ProjectFilterMatchesV1('verified_project', 'verified_project'), true);
    assert.equal(b20ProjectFilterMatchesV1('verified_project', 'unverified'), false);
    assert.equal(b20ProjectFilterMatchesV1('product_backed', 'verified_project'), false);
    assert.equal(b20ProjectFilterMatchesV1('unknown', 'unverified'), true);
    assert.equal(b20ProjectFilterMatchesV1('unknown', 'product_backed'), false);
  });

  test('every filter passes everything under `all`', () => {
    for (const standing of ['product_backed', 'verified_project', 'unverified'] as const) {
      assert.equal(b20ProjectFilterMatchesV1('all', standing), true);
    }
    assert.equal(B20_PROJECT_FILTERS_V1.length, 4);
  });
});

// ---------------------------------------------------------------------------
// The write path and the read path must say the same thing.
//
// A profile is decided once by a collector and rendered from stored rows on
// every card afterwards. If those two disagree, the API, the MCP and the UI
// stop quoting the same evidence — which is the acceptance requirement stated
// as a property rather than as a screenshot.
// ---------------------------------------------------------------------------
describe('a stored profile reads back identical to the one that was written', () => {
  const collected = b20FundamentalProfileV1(
    evidence({
      website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW },
      product: { url: 'https://miorail.xyz/mcp', reachable: true, functional: true, observedAt: NOW },
      docs: { url: 'https://miorail.xyz/docs', reachable: true, observedAt: NOW },
      repository: {
        url: 'https://github.com/mioku50/mioagent',
        createdAt: '2025-03-01T00:00:00.000Z',
        lastCommitAt: '2026-08-15T00:00:00.000Z',
        observedAt: NOW,
      },
      basePresence: { kind: 'mcp_endpoint', reference: 'https://miorail.xyz/mcp', observedAt: NOW },
      launchedAt: '2026-07-01T00:00:00.000Z',
    }),
  );

  test('every finding survives a round trip through storage', () => {
    const rows = collected.findings.map((finding) => ({
      dimension: finding.dimension,
      state: finding.state,
      provenance: finding.provenance,
      reference: finding.reference,
      observedAt: finding.observedAt!,
    }));
    const rebuilt = b20FundamentalProfileFromStoredV1({
      claim: VERIFIED_CLAIM,
      claimantDomain: 'miorail.xyz',
      rows,
    });
    assert.equal(rebuilt.standing, collected.standing);
    assert.equal(rebuilt.headline, collected.headline);
    assert.equal(rebuilt.detail, collected.detail);
    assert.deepEqual(rebuilt.findings, collected.findings);
    assert.deepEqual(rebuilt.missing, collected.missing);
  });

  test('rows for a token whose claim is not verified are dropped, not rendered', () => {
    // The second of two locks on the same door: the storage layer refuses to
    // write this combination, and the read path refuses to render it.
    const rebuilt = b20FundamentalProfileFromStoredV1({
      claim: NO_CLAIM,
      claimantDomain: null,
      rows: collected.findings.map((finding) => ({
        dimension: finding.dimension,
        state: finding.state,
        provenance: finding.provenance,
        reference: finding.reference,
        observedAt: finding.observedAt!,
      })),
    });
    assert.equal(rebuilt.identityVerified, false);
    assert.equal(rebuilt.findings.length, 0);
    assert.ok(!JSON.stringify(rebuilt).includes('github.com'));
  });

  test('every state the projection can produce has copy', () => {
    // A missing pair would print a fallback on a production card, and the
    // fallback is deliberately bland enough that nobody would notice.
    const produced = new Set<string>();
    for (const profile of [collected]) {
      for (const finding of profile.findings) produced.add(fundamentalCopyKeyV1(finding.dimension, finding.state));
    }
    for (const extra of [
      ['website', 'unverified'], ['product', 'found'], ['product', 'unknown'],
      ['repository', 'found'], ['docs', 'unknown'], ['project_before_token', 'no'],
      ['development_activity', 'quiet'],
    ] as const) {
      produced.add(fundamentalCopyKeyV1(extra[0], extra[1]));
    }
    for (const key of produced) {
      assert.ok(B20_FUNDAMENTAL_COPY_V1[key], `no copy for ${key}`);
      assert.ok(B20_FUNDAMENTAL_COPY_V1[key]!.note.length > 20, `${key} has no bound on its claim`);
    }
  });
});
