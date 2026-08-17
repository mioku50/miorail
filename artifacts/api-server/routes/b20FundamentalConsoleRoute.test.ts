import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';

import { createMemoryB20ProjectRepository } from '@mioagent/route-storage';

import { b20ControlRouter, b20RouteRuntime, resetB20SummaryCacheV1 } from './b20Control.js';

// ---------------------------------------------------------------------------
// Fundamental predicates, end to end over HTTP.
//
// Two defects are pinned here, and both were invisible to a unit test because
// each lived in the seam between a planner, a read and an answer:
//
//   A fundamental question ran a 48-hour universe summary first, so every
//   project answer opened with how many launches had been MEASURED — a number
//   about a different corpus, printed where the denominator belongs.
//
//   The claimed-token read dropped any token Discover had no launch row for,
//   with a silent `continue`. A project verified before its launch was ingested
//   would have been answered "none" while its claim sat verified in the
//   database.
//
// The fixture below is built so that the second one cannot pass by accident:
// the verified project with a live product is the one with NO launch row.
// ---------------------------------------------------------------------------

const WALLET = '0x1111111111111111111111111111111111111111';
/** Claimed, verified, live product — and deliberately NOT in the launch index. */
const UNINDEXED = '0xb200000000000000000000578f3ae29d9e6e0101';
/** Claimed, verified, website only — and present in the index. */
const INDEXED = '0xb200000000000000000000195a5f43905160ee01';

const NOW = '2026-08-16T12:00:00.000Z';

function projectsFixtureV1() {
  const repository = createMemoryB20ProjectRepository();
  return async () => {
    await repository.recordVerification({
      claim: {
        chainId: 8453,
        tokenAddress: UNINDEXED,
        claimantDomain: 'miorail.xyz',
        status: 'verified',
        verifiedLinks: ['domain_file'],
        refutedLinks: [],
        lastCheckedAt: NOW,
      },
      evidence: [
        {
          chainId: 8453,
          tokenAddress: UNINDEXED,
          dimension: 'project_identity',
          state: 'verified',
          provenance: 'domain_claim_file',
          reference: 'miorail.xyz',
          observedAt: NOW,
        },
        {
          chainId: 8453,
          tokenAddress: UNINDEXED,
          dimension: 'product',
          state: 'live',
          provenance: 'functional_probe',
          reference: 'https://miorail.xyz/mcp',
          observedAt: NOW,
        },
      ],
    });
    await repository.recordVerification({
      claim: {
        chainId: 8453,
        tokenAddress: INDEXED,
        claimantDomain: 'other.xyz',
        status: 'verified',
        verifiedLinks: ['domain_file'],
        refutedLinks: [],
        lastCheckedAt: NOW,
      },
      evidence: [
        {
          chainId: 8453,
          tokenAddress: INDEXED,
          dimension: 'project_identity',
          state: 'verified',
          provenance: 'domain_claim_file',
          reference: 'other.xyz',
          observedAt: NOW,
        },
        {
          chainId: 8453,
          tokenAddress: INDEXED,
          dimension: 'website',
          state: 'verified',
          provenance: 'https_probe',
          reference: 'https://other.xyz',
          observedAt: NOW,
        },
      ],
    });
    return repository;
  };
}

/**
 * The one observation call the fundamental read makes.
 *
 * Everything else throws on purpose: a fundamental answer that reached for the
 * feed, the summary or the pipeline would be reading the measured universe
 * again, and this fixture makes that a test failure rather than a paragraph
 * nobody notices.
 */
function observationsFixtureV1() {
  return {
    getFeedRowForToken: async (input: { tokenAddress: string }) => {
      if (input.tokenAddress.toLowerCase() !== INDEXED) return null;
      return {
        row: {
          launch: {
            tokenAddress: INDEXED,
            name: 'Other',
            symbol: 'OTH',
            variant: 'asset',
            decimals: 18,
            blockNumber: '49929300',
            transactionHash: `0x${'1'.repeat(64)}`,
            logIndex: 0,
            detectedAt: NOW,
            blockTimestamp: null,
            canonical: true,
          },
          observation: null,
          launchBuyers: null,
        },
        history: [],
      };
    },
    listFeed: async () => {
      throw new Error('a fundamental answer read the measured feed');
    },
    summaryCounts: async () => {
      throw new Error('a fundamental answer read the universe summary');
    },
    pipelineCounts: async () => {
      throw new Error('a fundamental answer read the pipeline');
    },
  } as never;
}

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    Object.defineProperty(req, 'session', {
      configurable: true,
      value: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } },
    });
    next();
  });
  server.use('/api/route-intelligence', b20ControlRouter);
  return server;
}

const original = { ...b20RouteRuntime };
const openProjects = projectsFixtureV1();

beforeEach(async () => {
  resetB20SummaryCacheV1();
  const projects = await openProjects();
  b20RouteRuntime.flags = () => ({ routeIntelligenceV1: true, b20ControlV1: true }) as never;
  b20RouteRuntime.discoverAvailable = async () => true;
  b20RouteRuntime.observations = () => observationsFixtureV1();
  b20RouteRuntime.projectsAvailable = async () => true;
  b20RouteRuntime.projects = () => projects;
  b20RouteRuntime.now = () => new Date(NOW);
  b20RouteRuntime.narrator = () => null;
});

afterEach(() => {
  resetB20SummaryCacheV1();
  Object.assign(b20RouteRuntime, original);
});

function ask(question: string) {
  return request(app())
    .post('/api/route-intelligence/opportunities/b20/console/ask')
    .send({ schemaVersion: 'b20-console-ask/v1', scope: 'explore', question });
}

describe('a live-product question is answered from the claimed corpus', () => {
  for (const question of [
    'Show B20 launches with a live product',
    'Какие B20 связаны с работающим продуктом?',
  ]) {
    test(`"${question}" finds the project Discover never ingested`, async () => {
      const response = await ask(question);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.intent, 'find_verified_projects');
      // The whole point: no launch row, and it is still the answer.
      assert.match(response.body.answer, new RegExp(UNINDEXED));
      assert.match(response.body.answer, /1 matched among 2 verified project claims/);
      assert.ok(
        !response.body.answer.includes(INDEXED) && !response.body.answer.includes('OTH'),
        'a project with no live product was included',
      );
    });
  }

  test('the missing launch row is reported as Miorail’s gap, not as the project’s', async () => {
    const response = await ask('Show B20 launches with a live product');
    const line = (response.body.missingEvidence as string[]).find((entry) =>
      entry.includes('no canonical launch row'),
    );
    assert.ok(line, `the index gap was not reported: ${JSON.stringify(response.body.missingEvidence)}`);
    assert.match(line!, /The project claim is unaffected/);
  });

  test('the reads name the project read and nothing else', async () => {
    const response = await ask('Show B20 launches with a live product');
    assert.deepEqual(
      (response.body.reads as { tool: string }[]).map((read) => read.tool),
      ['projects'],
    );
  });

  test('no market statistic appears anywhere in the response', async () => {
    // The observation fixture throws if the summary or the feed is read at all,
    // so this asserts the WORDS as well as the reads: a sentence about 3,000
    // launches could only come from a corpus this question was not asked of.
    const response = await ask('Show B20 launches with a live product');
    const text = JSON.stringify(response.body).toLowerCase();
    for (const word of ['launches read', 'bought', 'both directions', 'venue', 'buyer', 'exit']) {
      assert.ok(!text.includes(word), `a fundamental answer said "${word}"`);
    }
  });
});

describe('the other predicates read their own dimension', () => {
  test('a website question finds the indexed project and not the product one', async () => {
    const response = await ask('Какие B20 имеют проверенный сайт?');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.answer, /1 matched among 2 verified project claims/);
    assert.match(response.body.answer, /OTH/);
    assert.ok(!response.body.answer.includes(UNINDEXED), 'the product project answered a website question');
  });

  test('a repository question matches nobody, and says so against the corpus', async () => {
    const response = await ask('Which B20 projects have a repository?');
    assert.match(response.body.answer, /None of the 2 verified project claims/);
    assert.match(response.body.answer, /outside this fundamental corpus and remain unknown/);
  });

  test('the claim predicate finds both, because it asks about the gate', async () => {
    const response = await ask('Which B20 launches are connected to verified projects?');
    assert.match(response.body.answer, /2 matched among 2 verified project claims/);
  });
});

describe('a question for an absence is refused before any read', () => {
  for (const question of ['Which B20 have no product?', 'какие B20 без продукта?']) {
    test(`"${question}" is refused`, async () => {
      const response = await ask(question);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.intent, 'unsupported');
      assert.match(response.body.answer, /cannot answer which projects lack something/i);
      assert.deepEqual(response.body.reads, []);
    });
  }
});
