import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_CLAIM_FILE_PATH_V1,
  claimUrlAllowedV1,
  githubRepoPathV1,
  hostBelongsToDomainV1,
  isNonPublicHostV1,
  verifyB20ProjectV1,
  type B20CollectDepsV1,
  type B20HttpResponseV1,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// The collector is where a project's own words become Miorail's evidence, so
// it is also where somebody else's project could become this token's. Every
// test here is one of those routes.
//
// Nothing reaches the network: the http dependency is a table of canned
// responses, and a request to a URL not in the table is a hard failure rather
// than a silent miss.
// ---------------------------------------------------------------------------

const NOW = '2026-08-16T12:00:00.000Z';
const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const SENDER = '0x4de20000000000000000000000000000000000d7';

const CLAIM_FILE = {
  schemaVersion: 'miorail-b20-claim/v1',
  tokens: [{ chainId: 8453, address: TOKEN }],
  launchSender: SENDER,
  project: {
    name: 'Miorail',
    website: 'https://miorail.xyz',
    product: 'https://miorail.xyz/mcp',
    repository: 'https://github.com/mioku50/mioagent',
    docs: 'https://miorail.xyz/docs',
    publication: 'https://miorail.xyz/api/status',
    baseContract: null,
  },
};

function response(over: Partial<B20HttpResponseV1> = {}): B20HttpResponseV1 {
  return { ok: true, status: 200, contentType: 'application/json', bodyText: '{}', ...over };
}

interface Recorded {
  url: string;
  post: boolean;
}

function deps(
  table: Record<string, B20HttpResponseV1 | ((post: boolean) => B20HttpResponseV1)>,
  recorded: Recorded[] = [],
): B20CollectDepsV1 {
  return {
    now: () => NOW,
    http: async ({ url, postJson }) => {
      recorded.push({ url, post: postJson !== undefined });
      const entry = table[url];
      if (!entry) throw new Error(`unmocked ${url}`);
      return typeof entry === 'function' ? entry(postJson !== undefined) : entry;
    },
  };
}

const MCP_STREAM = response({
  contentType: 'text/event-stream',
  bodyText: 'event: message\ndata: {"result":{"tools":[{"name":"a"},{"name":"b"}]},"jsonrpc":"2.0","id":1}\n',
});

const GITHUB = response({
  bodyText: JSON.stringify({ created_at: '2025-03-01T00:00:00Z', pushed_at: '2026-08-15T00:00:00Z' }),
});

const FULL_TABLE = {
  [`https://miorail.xyz${B20_CLAIM_FILE_PATH_V1}`]: response({ bodyText: JSON.stringify(CLAIM_FILE) }),
  'https://miorail.xyz/api/status': response({ bodyText: JSON.stringify({ token: TOKEN }) }),
  'https://miorail.xyz': response({ contentType: 'text/html', bodyText: '<html></html>' }),
  'https://miorail.xyz/docs': response({ contentType: 'text/html', bodyText: '<html></html>' }),
  'https://miorail.xyz/mcp': (post: boolean) => (post ? MCP_STREAM : response({ bodyText: '{}' })),
  'https://api.github.com/repos/mioku50/mioagent': GITHUB,
};

const INPUT = {
  chainId: 8453,
  tokenAddress: TOKEN,
  domain: 'miorail.xyz',
  launchSender: SENDER,
  senderRelation: 'direct',
  launchedAt: '2026-07-01T00:00:00.000Z',
};

describe('the reference case: a project that proves everything it claims', () => {
  test('three verified links, a live product and a repository older than the token', async () => {
    const result = await verifyB20ProjectV1(deps(FULL_TABLE), INPUT);
    assert.equal(result.refusal, null);
    assert.equal(result.claim?.status, 'verified');
    assert.deepEqual([...(result.claim?.verifiedLinks ?? [])].sort(), [
      'domain_file',
      'launch_sender',
      'project_publication',
    ]);
    assert.equal(result.profile.standing, 'product_backed');
    const state = (dimension: string) =>
      result.profile.findings.find((finding) => finding.dimension === dimension)?.state;
    assert.equal(state('project_identity'), 'verified');
    assert.equal(state('website'), 'verified');
    assert.equal(state('product'), 'live');
    assert.equal(state('repository'), 'active');
    assert.equal(state('docs'), 'found');
    assert.equal(state('project_before_token'), 'yes');
    assert.equal(state('development_activity'), 'active');
    assert.equal(state('base_presence'), 'verified');
    assert.deepEqual(result.profile.missing, []);
  });
});

describe('the gate closes before anything is fetched', () => {
  test('a claim file that does not name this token attaches nothing, and probes nothing', async () => {
    // The impostor case as it actually arrives: a real project's file, read for
    // a token that is not in it.
    const recorded: Recorded[] = [];
    const result = await verifyB20ProjectV1(deps(FULL_TABLE, recorded), {
      ...INPUT,
      tokenAddress: '0xb200000000000000000000000000000000000bad',
    });
    assert.equal(result.refusal, 'token_not_named');
    assert.equal(result.claim, null);
    assert.equal(result.profile.identityVerified, false);
    assert.equal(result.profile.findings.length, 0);
    // And it stopped at the gate: only the claim file was requested.
    assert.deepEqual(recorded.map((entry) => entry.url), [`https://miorail.xyz${B20_CLAIM_FILE_PATH_V1}`]);
  });

  test('the same symbol on a different address gets no profile at all', async () => {
    // A copycat serves a valid file from its OWN domain naming its OWN token.
    // It gets its own unverified answer, and nothing from miorail.xyz.
    const copycat = '0xb2000000000000000000000000000000000c0d1';
    const result = await verifyB20ProjectV1(
      deps({ [`https://fake-miorail.xyz${B20_CLAIM_FILE_PATH_V1}`]: response({ ok: false, status: 404 }) }),
      { ...INPUT, tokenAddress: copycat, domain: 'fake-miorail.xyz' },
    );
    assert.equal(result.profile.identityVerified, false);
    assert.ok(!JSON.stringify(result.profile).includes('miorail.xyz'));
  });

  test('an unreachable, unparseable or invalid file all refuse without probing', async () => {
    for (const [body, expected] of [
      [response({ ok: false, status: 404 }), 'unreachable'],
      [response({ bodyText: 'not json' }), 'not_json'],
      [response({ bodyText: JSON.stringify({ schemaVersion: 'other/v1' }) }), 'invalid_schema'],
    ] as const) {
      const recorded: Recorded[] = [];
      const result = await verifyB20ProjectV1(
        deps({ [`https://miorail.xyz${B20_CLAIM_FILE_PATH_V1}`]: body }, recorded),
        INPUT,
      );
      assert.equal(result.refusal, expected);
      assert.equal(recorded.length, 1, `${expected} kept probing after the gate closed`);
    }
  });
});

describe('a declared sender the chain contradicts refutes the whole claim', () => {
  test('a mismatched launch sender refutes, and attaches nothing', async () => {
    const recorded: Recorded[] = [];
    const result = await verifyB20ProjectV1(deps(FULL_TABLE, recorded), {
      ...INPUT,
      launchSender: '0x1111111111111111111111111111111111111111',
    });
    assert.equal(result.claim?.status, 'refuted');
    assert.deepEqual([...(result.claim?.refutedLinks ?? [])], ['launch_sender']);
    assert.equal(result.profile.identityVerified, false);
    assert.equal(result.profile.findings.length, 0);
    // The publication fetch had already run when the mismatch was found; no
    // product, repository or website probe did.
    assert.ok(!recorded.some((entry) => entry.url.includes('api.github.com')));
    assert.ok(!recorded.some((entry) => entry.url === 'https://miorail.xyz/mcp'));
  });

  test('a relayed launch cannot verify the sender link, and is not refuted by it', async () => {
    // On a bundled transaction `tx.from` is a bundler. Comparing a declared
    // sender against it would refute honest projects and verify dishonest ones.
    const result = await verifyB20ProjectV1(deps(FULL_TABLE), { ...INPUT, senderRelation: 'bundler' });
    assert.equal(result.claim?.status, 'verified');
    assert.ok(!result.claim!.verifiedLinks.includes('launch_sender'));
    assert.ok(!result.claim!.refutedLinks.includes('launch_sender'));
  });

  test('an unread launch transaction leaves the link unchecked', async () => {
    const result = await verifyB20ProjectV1(deps(FULL_TABLE), {
      ...INPUT,
      launchSender: null,
      senderRelation: null,
    });
    assert.equal(result.claim?.status, 'verified');
    assert.ok(!result.claim!.verifiedLinks.includes('launch_sender'));
  });
});

describe('a claim file may not point Miorail anywhere it likes', () => {
  test('an off-domain product is refused and never fetched', async () => {
    const recorded: Recorded[] = [];
    const file = {
      ...CLAIM_FILE,
      project: { ...CLAIM_FILE.project, product: 'https://someone-elses-product.example/api' },
    };
    const result = await verifyB20ProjectV1(
      deps(
        { ...FULL_TABLE, [`https://miorail.xyz${B20_CLAIM_FILE_PATH_V1}`]: response({ bodyText: JSON.stringify(file) }) },
        recorded,
      ),
      INPUT,
    );
    assert.ok(!recorded.some((entry) => entry.url.includes('someone-elses-product')));
    assert.deepEqual(result.refusedUrls, [
      { url: 'https://someone-elses-product.example/api', refusal: 'off_domain' },
    ]);
    // And the dimension is unknown rather than borrowed.
    assert.ok(result.profile.missing.includes('product'));
    assert.equal(result.profile.standing, 'verified_project');
  });

  test('a private or loopback host is refused before a request is made', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
      assert.equal(isNonPublicHostV1(host), true, `${host} was treated as public`);
      assert.equal(
        claimUrlAllowedV1({ url: `https://${host}/x`, domain: host, kind: 'same_domain' }).allowed,
        false,
        `${host} passed the URL gate`,
      );
    }
    assert.equal(isNonPublicHostV1('miorail.xyz'), false);
    assert.equal(isNonPublicHostV1('8.8.8.8'), false);
  });

  test('http is refused; only https is fetched', () => {
    assert.equal(
      claimUrlAllowedV1({ url: 'http://miorail.xyz/x', domain: 'miorail.xyz', kind: 'same_domain' }).allowed,
      false,
    );
  });

  test('a subdomain belongs and a lookalike does not', () => {
    assert.equal(hostBelongsToDomainV1('app.miorail.xyz', 'miorail.xyz'), true);
    assert.equal(hostBelongsToDomainV1('miorail.xyz', 'miorail.xyz'), true);
    // The attack this is written against: a suffix match without the dot.
    assert.equal(hostBelongsToDomainV1('notmiorail.xyz', 'miorail.xyz'), false);
    assert.equal(hostBelongsToDomainV1('miorail.xyz.evil.com', 'miorail.xyz'), false);
  });

  test('a repository on an unsupported host is refused rather than guessed at', () => {
    assert.equal(
      claimUrlAllowedV1({ url: 'https://gitlab.com/a/b', domain: 'miorail.xyz', kind: 'repository' }).allowed,
      false,
    );
    assert.equal(githubRepoPathV1('https://gitlab.com/a/b'), null);
    assert.equal(githubRepoPathV1('https://github.com/mioku50/mioagent'), 'mioku50/mioagent');
    assert.equal(githubRepoPathV1('https://github.com/mioku50/mioagent.git'), 'mioku50/mioagent');
    assert.equal(githubRepoPathV1('https://github.com/mioku50'), null);
  });
});

describe('a page that renders is not a product that runs', () => {
  test('an HTML product endpoint is `found`, and the standing stays verified_project', async () => {
    const table = {
      ...FULL_TABLE,
      'https://miorail.xyz/mcp': response({ contentType: 'text/html', bodyText: '<html>Welcome</html>' }),
    };
    const result = await verifyB20ProjectV1(deps(table), INPUT);
    const product = result.profile.findings.find((finding) => finding.dimension === 'product');
    assert.equal(product?.state, 'found');
    assert.equal(result.profile.standing, 'verified_project');
  });

  test('a JSON content type with a body that does not parse is not functional', async () => {
    const table = {
      ...FULL_TABLE,
      'https://miorail.xyz/mcp': response({ contentType: 'application/json', bodyText: '<html>' }),
    };
    const result = await verifyB20ProjectV1(deps(table), INPUT);
    assert.equal(result.profile.findings.find((f) => f.dimension === 'product')?.state, 'found');
  });

  test('an MCP endpoint that answers a handshake is live', async () => {
    const result = await verifyB20ProjectV1(deps(FULL_TABLE), INPUT);
    assert.equal(result.profile.findings.find((f) => f.dimension === 'product')?.state, 'live');
    assert.equal(result.profile.findings.find((f) => f.dimension === 'base_presence')?.state, 'verified');
  });
});

describe('a missing declaration stays unknown', () => {
  test('a file with no repository, docs or website leaves those dimensions missing', async () => {
    const bare = {
      ...CLAIM_FILE,
      project: {
        name: 'Miorail',
        website: null,
        product: null,
        repository: null,
        docs: null,
        publication: null,
        baseContract: null,
      },
    };
    const result = await verifyB20ProjectV1(
      deps({ [`https://miorail.xyz${B20_CLAIM_FILE_PATH_V1}`]: response({ bodyText: JSON.stringify(bare) }) }),
      INPUT,
    );
    assert.equal(result.profile.identityVerified, true);
    assert.equal(result.profile.standing, 'verified_project');
    for (const dimension of ['website', 'product', 'repository', 'docs', 'development_activity']) {
      assert.ok(result.profile.missing.includes(dimension as never), `${dimension} was not left unknown`);
    }
    // One finding: the identity itself.
    assert.equal(result.profile.findings.length, 1);
  });

  test('a GitHub read that fails leaves the repository unknown, never absent', async () => {
    const table = { ...FULL_TABLE, 'https://api.github.com/repos/mioku50/mioagent': response({ ok: false, status: 403 }) };
    const result = await verifyB20ProjectV1(deps(table), INPUT);
    assert.ok(result.profile.missing.includes('repository'));
    assert.ok(result.profile.missing.includes('project_before_token'));
    assert.ok(result.profile.missing.includes('development_activity'));
  });
});
