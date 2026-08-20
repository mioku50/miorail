import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  b20ClaimStandingV1,
  b20FundamentalProfileV1,
  b20PublicContextV1,
} from '@mioagent/opportunity-rail';

import { b20PossiblePublicContextAnswerV1 } from './b20ConsoleAnswer.js';

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const NOW = '2026-08-20T18:00:00.000Z';

function publicContextV1(
  candidates: Array<{
    kind: 'website' | 'repository' | 'social';
    url: string;
    host: string;
    origin: 'search_result' | 'symbol_search' | 'linked_from_website' | 'operator_supplied';
    fetched: boolean;
  }> = [
    {
      kind: 'website',
      url: 'https://candidate.example',
      host: 'candidate.example',
      origin: 'search_result',
      fetched: true,
    },
  ],
) {
  return b20PublicContextV1({
    chainId: 8453,
    tokenAddress: TOKEN,
    lookup: { kind: 'search', completed: true },
    candidates,
    pageNamesToken: { found: true, reference: 'candidate.example' },
    siteLinksRepository: null,
    repositoryLinksSite: null,
    siteLinksSocial: null,
    socialLinksSite: null,
    observedAt: NOW,
  });
}

function verifiedFundamentalV1() {
  return b20FundamentalProfileV1({
    claim: b20ClaimStandingV1({
      claimantDomain: 'miorail.xyz',
      status: 'verified',
      verifiedLinks: ['domain_file'],
      refutedLinks: [],
      lastCheckedAt: NOW,
    }),
    claimantDomain: 'miorail.xyz',
    website: { url: 'https://miorail.xyz', reachable: true, observedAt: NOW },
    product: null,
    docs: null,
    repository: null,
    basePresence: null,
    launchedAt: null,
    now: NOW,
  });
}

describe('Possible Public Context never becomes Fundamental evidence', () => {
  const answer = b20PossiblePublicContextAnswerV1({
    tokenAddress: TOKEN,
    symbol: 'MIO',
    context: publicContextV1(),
    unavailableReason: null,
    fundamental: verifiedFundamentalV1(),
    fundamentalLayerAvailable: true,
  });

  test('the headline and every candidate remain explicitly UNVERIFIED', () => {
    assert.match(answer.answer, /^Possible Public Context for MIO is UNVERIFIED\./);
    const candidates = answer.facts.filter((fact) => fact.value.includes('candidate.example'));
    assert.equal(candidates.length, 1);
    assert.match(candidates[0]!.label, /^UNVERIFIED /);
    assert.equal(candidates[0]!.tone, 'warning');
  });

  test('verified Fundamental evidence is rendered in separate rows', () => {
    const verified = answer.facts.filter((fact) => fact.label.startsWith('Verified Fundamental evidence'));
    assert.ok(verified.length >= 2);
    assert.ok(verified.some((fact) => fact.value.includes('miorail.xyz')));
    assert.ok(verified.every((fact) => !fact.value.includes('candidate.example')));
    assert.match(answer.answer, /does not verify, adopt or upgrade any candidate above/i);
  });

  test('a long public candidate list cannot crowd verified evidence out', () => {
    const noisyContext = publicContextV1(
      Array.from({ length: 16 }, (_, index) => ({
        kind: 'website' as const,
        url: `https://candidate-${index}.example`,
        host: `candidate-${index}.example`,
        origin: 'search_result' as const,
        fetched: true,
      })),
    );
    const noisyAnswer = b20PossiblePublicContextAnswerV1({
      tokenAddress: TOKEN,
      symbol: 'MIO',
      context: noisyContext,
      unavailableReason: null,
      fundamental: verifiedFundamentalV1(),
      fundamentalLayerAvailable: true,
    });

    assert.ok(noisyAnswer.facts.length <= 16);
    assert.ok(
      noisyAnswer.facts.some((fact) =>
        fact.label.startsWith('Verified Fundamental evidence'),
      ),
    );
  });

  test('the plan evidence names two independent reads, never cards or projects', () => {
    assert.deepEqual(answer.reads.map((read) => read.tool), [
      'public-context',
      'fundamental-profile',
    ]);
    assert.ok(answer.reads.every((read) => read.tool !== 'cards' && read.tool !== 'projects'));
    assert.ok(answer.caveats.some((line) => /can never create or upgrade verified Fundamental evidence/.test(line)));
  });
});

test('an unavailable lookup concludes nothing about public accounts', () => {
  const answer = b20PossiblePublicContextAnswerV1({
    tokenAddress: TOKEN,
    symbol: null,
    context: null,
    unavailableReason: 'Public search is not configured on this deployment, so no public source was read.',
    fundamental: null,
    fundamentalLayerAvailable: false,
  });
  assert.match(answer.answer, /was not read/);
  assert.match(answer.answer, /No website, X, GitHub or domain conclusion was made/);
  assert.equal(answer.assertions.state, 'not_measured');
});
