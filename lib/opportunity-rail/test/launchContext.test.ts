import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  B20_CLAIM_LINKS_V1,
  B20_FACTORY_ADDRESS_V1,
  ERC4337_ENTRYPOINT_V1,
  b20ClaimStandingV1,
  b20LaunchContextV1,
  b20SenderRelationV1,
  b20SenderSupportsCountingV1,
  type B20DeployerCorpusV1,
} from '../src/launchContext.js';

// ---------------------------------------------------------------------------
// Launch Context.
//
// The naive version of this feature groups launches by `tx.from` and prints
// "this sender launched 8 tokens, 7 of which priced no sale". On a relayed
// transaction `tx.from` is whoever paid to include it, so those counts would
// put unrelated projects under one relayer — one project's record wearing
// another's name. Measured on 2,800 stored launches: 309 launches came through
// the ERC-4337 EntryPoint from SIX senders.
//
// These tests pin the refusal, not the counting.
// ---------------------------------------------------------------------------

const CORPUS: B20DeployerCorpusV1 = {
  launchCount: 8,
  standingCounts: [{ kind: 'no_exit_route', count: 7 }],
  standingSampleSize: 8,
  coverage: { launchesRead: 300, launchesTotal: 5909 },
};

const readingV1 = (transactionTo: string | null) => ({
  status: 'read' as const,
  deployerAddress: '0x1111111111111111111111111111111111111111',
  relation: b20SenderRelationV1(transactionTo),
  readAt: '2026-08-16T00:00:00.000Z',
});

describe('what a launch sender actually establishes', () => {
  test('straight to the factory is the anchor', () => {
    assert.equal(b20SenderRelationV1(B20_FACTORY_ADDRESS_V1), 'direct');
    assert.equal(b20SenderSupportsCountingV1('direct'), true);
  });

  test('the ERC-4337 EntryPoint means the sender is a bundler', () => {
    // Measured: 309 launches through this address from only SIX senders.
    assert.equal(b20SenderRelationV1(ERC4337_ENTRYPOINT_V1), 'bundler');
    assert.equal(b20SenderSupportsCountingV1('bundler'), false);
  });

  test('a checksummed recipient is the same recipient', () => {
    assert.equal(b20SenderRelationV1(B20_FACTORY_ADDRESS_V1.toUpperCase().replace('0X', '0x')), 'direct');
  });

  test('any other contract leaves the question open', () => {
    assert.equal(b20SenderRelationV1('0xa52ad458ce0282a971ecc71c051a32f28946bb9f'), 'intermediary');
    assert.equal(b20SenderSupportsCountingV1('intermediary'), false);
  });

  test('no recipient is a contract creation, and still not countable', () => {
    assert.equal(b20SenderRelationV1(null), 'contract_creation');
    assert.equal(b20SenderSupportsCountingV1('contract_creation'), false);
  });
});

describe('a count is dropped, not hidden, when the sender cannot carry it', () => {
  test('a bundler’s launches are never counted together', () => {
    const context = b20LaunchContextV1({ reading: readingV1(ERC4337_ENTRYPOINT_V1), corpus: CORPUS, claim: null });
    // Dropped from the model itself: a surface cannot render a count this
    // layer refused to make.
    assert.equal(context.corpus, null);
    assert.ok(
      context.caveats.some((caveat) => /would group unrelated projects under one address/.test(caveat)),
      context.caveats.join(' | '),
    );
  });

  test('an intermediary is refused for the same reason', () => {
    assert.equal(
      b20LaunchContextV1({ reading: readingV1('0xa52ad458ce0282a971ecc71c051a32f28946bb9f'), corpus: CORPUS, claim: null }).corpus,
      null,
    );
  });

  test('a direct sender keeps its counts, with the denominator attached', () => {
    const context = b20LaunchContextV1({ reading: readingV1(B20_FACTORY_ADDRESS_V1), corpus: CORPUS, claim: null });
    assert.equal(context.corpus?.launchCount, 8);
    assert.ok(
      context.caveats.some((caveat) => /over the 300 of 5909 stored launches/.test(caveat)),
      context.caveats.join(' | '),
    );
  });

  test('a breakdown over fewer launches than the count says so', () => {
    // launchCount 8 with a breakdown over 8 says nothing; a breakdown over
    // fewer must, or a fraction and a total sit in one sentence.
    const context = b20LaunchContextV1({
      reading: readingV1(B20_FACTORY_ADDRESS_V1),
      corpus: { ...CORPUS, launchCount: 359, standingSampleSize: 25 },
      claim: null,
    });
    assert.ok(
      context.caveats.some((caveat) => /broken down over 25 of the 359/.test(caveat)),
      context.caveats.join(' | '),
    );
  });

  test('a thin read says the count will grow', () => {
    const context = b20LaunchContextV1({ reading: readingV1(B20_FACTORY_ADDRESS_V1), corpus: CORPUS, claim: null });
    assert.ok(context.caveats.some((caveat) => /will grow as the backfill runs/.test(caveat)));
  });

  test('an address is never called a person', () => {
    const context = b20LaunchContextV1({ reading: readingV1(B20_FACTORY_ADDRESS_V1), corpus: CORPUS, claim: null });
    assert.ok(
      context.caveats.some((caveat) => /not a team, a company or a reputation/.test(caveat)),
    );
  });
});

describe('an unread launch is not a launch with no sender', () => {
  test('not read says so, and counts nothing', () => {
    const context = b20LaunchContextV1({ reading: { status: 'not_read' }, corpus: CORPUS, claim: null });
    assert.equal(context.corpus, null);
    assert.match(context.headline, /has not read this launch’s transaction/);
  });

  test('an absent transaction is a fact about the read', () => {
    const context = b20LaunchContextV1({
      reading: { status: 'transaction_absent', readAt: '2026-08-16T00:00:00.000Z' },
      corpus: CORPUS,
      claim: null,
    });
    assert.equal(context.corpus, null);
    assert.ok(context.caveats.some((caveat) => /a fact about the read, not about the token/.test(caveat)));
  });
});

describe('identity is claimed, never guessed', () => {
  test('no claim is the default, and it is not a warning', () => {
    const standing = b20ClaimStandingV1(null);
    assert.equal(standing.status, 'no_claim');
    assert.equal(standing.headline, 'Unverified context.');
    assert.match(standing.detail, /most launches are never claimed/);
    assert.equal(standing.verifiedLabel, '0 of 3');
    assert.deepEqual(standing.uncheckedLinks, B20_CLAIM_LINKS_V1);
  });

  test('a claim with nothing verified is an assertion by whoever made it', () => {
    const standing = b20ClaimStandingV1({
      claimantDomain: 'example.org',
      status: 'unverified',
      verifiedLinks: [],
      refutedLinks: [],
      lastCheckedAt: null,
    });
    assert.match(standing.detail, /an assertion by whoever made it/);
    assert.equal(standing.verifiedLabel, '0 of 3');
  });

  test('a verified claim names the LINK, never endorses the project', () => {
    const standing = b20ClaimStandingV1({
      claimantDomain: 'example.org',
      status: 'verified',
      verifiedLinks: ['launch_sender'],
      refutedLinks: [],
      lastCheckedAt: '2026-08-16T00:00:00.000Z',
    });
    assert.equal(standing.verifiedLabel, '1 of 3');
    assert.match(standing.detail, /did not review the project, its team or its code/);
    assert.deepEqual(standing.uncheckedLinks, ['domain_file', 'project_publication']);
  });

  test('there is no score anywhere in the standing', () => {
    // A single number folding unlike evidence together would be sorted, and a
    // ranked list of tokens is an investment signal whatever it is called.
    const standing = b20ClaimStandingV1({
      claimantDomain: 'example.org',
      status: 'verified',
      verifiedLinks: ['launch_sender', 'domain_file'],
      refutedLinks: [],
      lastCheckedAt: null,
    });
    for (const key of Object.keys(standing)) {
      assert.equal(/score|rating|rank|grade/i.test(key), false, `${key} looks like a score`);
    }
    assert.match(standing.verifiedLabel, /^\d+ of \d+$/);
  });

  test('a refuted claim is about the claim, not about the token', () => {
    const standing = b20ClaimStandingV1({
      claimantDomain: 'example.org',
      status: 'refuted',
      verifiedLinks: [],
      refutedLinks: ['domain_file'],
      lastCheckedAt: '2026-08-16T00:00:00.000Z',
    });
    assert.match(standing.detail, /not about the token/);
  });
});
