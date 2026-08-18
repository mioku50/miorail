import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  claimPermitsEvidenceV1,
  type B20ProjectClaimRowV1,
  type B20ProjectEvidenceRowV1,
  type B20ProjectRepositoryV1,
} from '../src/b20Projects.js';

const TOKEN = '0xb200000000000000000000578f3ae29d9e6e0101';
const OTHER = '0xb200000000000000000000000000000000000bad';

export function claimFixtureV1(overrides: Partial<B20ProjectClaimRowV1> = {}): B20ProjectClaimRowV1 {
  return {
    chainId: 8453,
    tokenAddress: TOKEN,
    claimantDomain: 'miorail.xyz',
    status: 'verified',
    verifiedLinks: ['domain_file', 'launch_sender'],
    refutedLinks: [],
    lastCheckedAt: '2026-08-16T11:00:00.000Z',
    ...overrides,
  };
}

export function evidenceFixtureV1(
  overrides: Partial<B20ProjectEvidenceRowV1> = {},
): B20ProjectEvidenceRowV1 {
  return {
    chainId: 8453,
    tokenAddress: TOKEN,
    dimension: 'product',
    state: 'live',
    provenance: 'functional_probe',
    reference: 'https://miorail.xyz/mcp',
    observedAt: '2026-08-16T11:00:00.000Z',
    ...overrides,
  };
}

/**
 * The contract both repositories are held to.
 *
 * Every case here is a route by which one project's record could end up on
 * another token, or by which "not collected" could become "collected and
 * negative". The database enforces them with CHECK constraints and a foreign
 * key; the memory fake has to refuse exactly the same writes, because a fake
 * that is more permissive lets a test pass on a row production cannot store.
 */
export function b20ProjectContractV1(
  label: string,
  open: () => Promise<{ repository: B20ProjectRepositoryV1 }>,
) {
  describe(`B20 project repository (${label})`, () => {
    test('an unclaimed token reads as null, not as an empty record', async () => {
      const { repository } = await open();
      assert.equal(await repository.readProject({ chainId: 8453, tokenAddress: TOKEN }), null);
      assert.deepEqual(await repository.readProjects({ chainId: 8453, tokenAddresses: [TOKEN] }), []);
    });

    test('a verified claim stores its evidence and reads it back whole', async () => {
      const { repository } = await open();
      await repository.recordVerification({
        claim: claimFixtureV1(),
        evidence: [
          evidenceFixtureV1({ dimension: 'project_identity', state: 'verified', provenance: 'domain_claim_file', reference: null }),
          evidenceFixtureV1(),
        ],
      });
      const record = await repository.readProject({ chainId: 8453, tokenAddress: TOKEN });
      assert.equal(record?.claim.claimantDomain, 'miorail.xyz');
      assert.equal(record?.evidence.length, 2);
      assert.ok(record?.evidence.some((row) => row.dimension === 'product' && row.state === 'live'));
    });

    test('evidence is REPLACED by a later pass, never merged', async () => {
      // A probe that no longer finds a product must not leave the old `live`
      // row standing beside the new reading.
      const { repository } = await open();
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [evidenceFixtureV1()] });
      await repository.recordVerification({
        claim: claimFixtureV1({ lastCheckedAt: '2026-08-16T12:00:00.000Z' }),
        evidence: [evidenceFixtureV1({ state: 'found', provenance: 'https_probe' })],
      });
      const record = await repository.readProject({ chainId: 8453, tokenAddress: TOKEN });
      assert.equal(record?.evidence.length, 1);
      assert.equal(record?.evidence[0]?.state, 'found');
    });

    test('evidence is refused for a claim that is not verified', async () => {
      const { repository } = await open();
      for (const claim of [
        claimFixtureV1({ status: 'unverified', verifiedLinks: [] }),
        claimFixtureV1({ status: 'refuted', verifiedLinks: [], refutedLinks: ['launch_sender'] }),
      ]) {
        assert.equal(claimPermitsEvidenceV1(claim), false);
        await assert.rejects(
          () => repository.recordVerification({ claim, evidence: [evidenceFixtureV1()] }),
          /refusing project evidence/,
          `${claim.status} claim accepted evidence`,
        );
      }
    });

    test('an unverified claim may still be recorded, with nothing attached', async () => {
      // The claim itself is a fact worth storing: it says somebody asserted a
      // link and it did not hold up. What it may not do is carry evidence.
      const { repository } = await open();
      await repository.recordVerification({
        claim: claimFixtureV1({ status: 'refuted', verifiedLinks: [], refutedLinks: ['launch_sender'] }),
        evidence: [],
      });
      const record = await repository.readProject({ chainId: 8453, tokenAddress: TOKEN });
      assert.equal(record?.claim.status, 'refuted');
      assert.deepEqual(record?.evidence, []);
    });

    test('evidence may not name a token other than the one its claim verified', async () => {
      // Written as its own refusal because this is the exact shape of one
      // project's record landing on another's card.
      const { repository } = await open();
      await assert.rejects(
        () =>
          repository.recordVerification({
            claim: claimFixtureV1(),
            evidence: [evidenceFixtureV1({ tokenAddress: OTHER })],
          }),
        /must belong to the token its claim was verified for/,
      );
    });

    test('a verified claim with no verified link is refused outright', async () => {
      const { repository } = await open();
      await assert.rejects(
        () => repository.recordVerification({ claim: claimFixtureV1({ verifiedLinks: [] }), evidence: [] }),
        /at least one verified link/,
      );
    });

    test('a link cannot be both verified and refuted', async () => {
      const { repository } = await open();
      await assert.rejects(
        () =>
          repository.recordVerification({
            claim: claimFixtureV1({ verifiedLinks: ['launch_sender'], refutedLinks: ['launch_sender'], status: 'refuted' }),
            evidence: [],
          }),
        /cannot be both verified and refuted/,
      );
    });

    test('only project_before_token may store a negative state', async () => {
      const { repository } = await open();
      for (const dimension of ['product', 'website', 'repository', 'development_activity'] as const) {
        await assert.rejects(
          () =>
            repository.recordVerification({
              claim: claimFixtureV1(),
              evidence: [evidenceFixtureV1({ dimension, state: 'no', provenance: 'https_probe' })],
            }),
          /may store a negative state/,
          `${dimension} was allowed to store a negative`,
        );
      }
      // And the one that may, does.
      await repository.recordVerification({
        claim: claimFixtureV1(),
        evidence: [
          evidenceFixtureV1({
            dimension: 'project_before_token',
            state: 'no',
            provenance: 'timestamp_comparison',
            reference: 'https://github.com/x/y',
          }),
        ],
      });
      const record = await repository.readProject({ chainId: 8453, tokenAddress: TOKEN });
      assert.equal(record?.evidence[0]?.state, 'no');
    });

    test('`not_collected` is never a stored provenance', async () => {
      // Unknown is the ABSENCE of a row. A row saying "we did not collect this"
      // is a value, and a value can be rendered.
      const { repository } = await open();
      await assert.rejects(
        () =>
          repository.recordVerification({
            claim: claimFixtureV1(),
            evidence: [evidenceFixtureV1({ provenance: 'not_collected' as never })],
          }),
        /not_collected is the absence of a row/,
      );
    });

    test('the claiming domain is a valid reference, and a scheme-bearing string is not', async () => {
      // The identity finding's reference is the DOMAIN — `miorail.xyz`, not
      // `https://miorail.xyz`, which would name the project's website. Caught
      // by this constraint on the first production write.
      const { repository } = await open();
      await repository.recordVerification({
        claim: claimFixtureV1(),
        evidence: [
          evidenceFixtureV1({
            dimension: 'project_identity',
            state: 'verified',
            provenance: 'domain_claim_file',
            reference: 'miorail.xyz',
          }),
        ],
      });
      const record = await repository.readProject({ chainId: 8453, tokenAddress: TOKEN });
      assert.equal(record?.evidence[0]?.reference, 'miorail.xyz');
    });

    test('a reference may only be an https URL, a bare address or a bare domain', async () => {
      const { repository } = await open();
      for (const reference of ['http://miorail.xyz', 'file:///etc/passwd', 'postgres://user:pw@host/db', 'anything', 'MIORAIL.XYZ']) {
        await assert.rejects(
          () =>
            repository.recordVerification({
              claim: claimFixtureV1(),
              evidence: [evidenceFixtureV1({ reference })],
            }),
          /https URL, a bare address or a bare domain/,
          `"${reference}" was stored as a reference`,
        );
      }
    });

    test('the verified list is what the Discover filter reads', async () => {
      const { repository } = await open();
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [] });
      await repository.recordVerification({
        claim: claimFixtureV1({
          tokenAddress: OTHER,
          status: 'refuted',
          verifiedLinks: [],
          refutedLinks: ['launch_sender'],
        }),
        evidence: [],
      });
      const verified = await repository.verifiedTokenAddresses({ chainId: 8453, limit: 10 });
      assert.deepEqual(verified, [TOKEN]);
    });

    test('a predicate read finds the tokens whose evidence matches, and only those', async () => {
      const { repository } = await open();
      await repository.recordVerification({
        claim: claimFixtureV1(),
        evidence: [evidenceFixtureV1()],
      });
      await repository.recordVerification({
        claim: claimFixtureV1({ tokenAddress: OTHER, claimantDomain: 'other.xyz' }),
        evidence: [
          evidenceFixtureV1({
            tokenAddress: OTHER,
            dimension: 'website',
            state: 'verified',
            provenance: 'https_probe',
            reference: 'https://other.xyz',
          }),
        ],
      });

      assert.deepEqual(
        await repository.tokensMatchingEvidence({
          chainId: 8453,
          dimension: 'product',
          states: ['live'],
          limit: 10,
        }),
        [TOKEN],
      );
      assert.deepEqual(
        await repository.tokensMatchingEvidence({
          chainId: 8453,
          dimension: 'website',
          states: ['verified'],
          limit: 10,
        }),
        [OTHER],
      );
      // A dimension nobody collected is an empty result, never every token.
      assert.deepEqual(
        await repository.tokensMatchingEvidence({
          chainId: 8453,
          dimension: 'docs',
          states: ['found'],
          limit: 10,
        }),
        [],
      );
    });

    test('a predicate takes a SET of states, because `active` is also `found`', async () => {
      // A reader asking which projects have a repository means the ones being
      // worked on too. A predicate pinned to a single state would drop exactly
      // those.
      const { repository } = await open();
      await repository.recordVerification({
        claim: claimFixtureV1(),
        evidence: [
          evidenceFixtureV1({
            dimension: 'repository',
            state: 'active',
            provenance: 'repository_api',
            reference: 'https://github.com/x/y',
          }),
        ],
      });
      assert.deepEqual(
        await repository.tokensMatchingEvidence({
          chainId: 8453,
          dimension: 'repository',
          states: ['found'],
          limit: 10,
        }),
        [],
      );
      assert.deepEqual(
        await repository.tokensMatchingEvidence({
          chainId: 8453,
          dimension: 'repository',
          states: ['found', 'active'],
          limit: 10,
        }),
        [TOKEN],
      );
    });

    test('evidence stops answering when its claim stops being verified', async () => {
      // The write path replaces evidence on every pass, so a refuted claim
      // should have none left. This asserts the READ refuses anyway: a query
      // that leans on the writer having been careful publishes an orphan the
      // day the writer changes.
      const { repository } = await open();
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [evidenceFixtureV1()] });
      assert.equal(
        (await repository.tokensMatchingEvidence({ chainId: 8453, dimension: 'product', states: ['live'], limit: 10 }))
          .length,
        1,
      );
      await repository.recordVerification({
        claim: claimFixtureV1({ status: 'refuted', verifiedLinks: [], refutedLinks: ['launch_sender'] }),
        evidence: [],
      });
      assert.deepEqual(
        await repository.tokensMatchingEvidence({ chainId: 8453, dimension: 'product', states: ['live'], limit: 10 }),
        [],
      );
    });

    test('an empty state set matches nothing rather than everything', async () => {
      const { repository } = await open();
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [evidenceFixtureV1()] });
      assert.deepEqual(
        await repository.tokensMatchingEvidence({ chainId: 8453, dimension: 'product', states: [], limit: 10 }),
        [],
      );
    });

    test('the predicate read honours its bound', async () => {
      const { repository } = await open();
      for (const address of [TOKEN, OTHER]) {
        await repository.recordVerification({
          claim: claimFixtureV1({ tokenAddress: address }),
          evidence: [evidenceFixtureV1({ tokenAddress: address })],
        });
      }
      const bounded = await repository.tokensMatchingEvidence({
        chainId: 8453,
        dimension: 'product',
        states: ['live'],
        limit: 1,
      });
      assert.equal(bounded.length, 1);
    });

    test('the corpus count is the verified claims, not the claims', async () => {
      // The denominator a fundamental answer states. A refuted claim is a
      // stored fact and is not part of the corpus a question is asked of.
      const { repository } = await open();
      assert.equal(await repository.verifiedClaimCount({ chainId: 8453 }), 0);
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [] });
      await repository.recordVerification({
        claim: claimFixtureV1({
          tokenAddress: OTHER,
          status: 'refuted',
          verifiedLinks: [],
          refutedLinks: ['launch_sender'],
        }),
        evidence: [],
      });
      assert.equal(await repository.verifiedClaimCount({ chainId: 8453 }), 1);
    });

    test('a bulk read returns only the tokens that have a claim', async () => {
      const { repository } = await open();
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [evidenceFixtureV1()] });
      const records = await repository.readProjects({ chainId: 8453, tokenAddresses: [TOKEN, OTHER] });
      assert.equal(records.length, 1);
      assert.equal(records[0]?.claim.tokenAddress, TOKEN);
    });

    // -----------------------------------------------------------------------
    // The re-verification queue.
    //
    // The verified layer shipped with no expiry at all: `Product — Live` meant
    // an endpoint answered a real request AT A MOMENT, and nothing ever asked
    // again. This is the read that finds what has gone un-current.
    // -----------------------------------------------------------------------
    describe('claims whose evidence has aged out are queued for another look', () => {
      const CUTOFF = '2026-08-17T11:00:00.000Z';

      test('a claim whose evidence predates the cutoff is due', async () => {
        const { repository } = await open();
        await repository.recordVerification({
          claim: claimFixtureV1(),
          evidence: [evidenceFixtureV1({ observedAt: '2026-08-16T11:00:00.000Z' })],
        });
        const due = await repository.claimsDueForReverification({
          chainId: 8453,
          observedBefore: CUTOFF,
          limit: 10,
        });
        assert.deepEqual(due, [
          { tokenAddress: TOKEN, projectDomain: 'miorail.xyz', oldestObservedAt: '2026-08-16T11:00:00.000Z' },
        ]);
      });

      test('a claim read after the cutoff is not', async () => {
        const { repository } = await open();
        await repository.recordVerification({
          claim: claimFixtureV1(),
          evidence: [evidenceFixtureV1({ observedAt: '2026-08-17T12:00:00.000Z' })],
        });
        assert.deepEqual(
          await repository.claimsDueForReverification({ chainId: 8453, observedBefore: CUTOFF, limit: 10 }),
          [],
        );
      });

      test('the OLDEST row decides, not the newest', async () => {
        // A fresh website reading must not vouch for a product probe nobody has
        // repeated. One stale dimension makes the claim due.
        const { repository } = await open();
        await repository.recordVerification({
          claim: claimFixtureV1(),
          evidence: [
            evidenceFixtureV1({ observedAt: '2026-08-17T12:00:00.000Z' }),
            evidenceFixtureV1({ dimension: 'website', state: 'verified', provenance: 'https_probe', observedAt: '2026-08-15T09:00:00.000Z' }),
          ],
        });
        const due = await repository.claimsDueForReverification({
          chainId: 8453,
          observedBefore: CUTOFF,
          limit: 10,
        });
        assert.equal(due.length, 1);
        assert.equal(due[0]?.oldestObservedAt, '2026-08-15T09:00:00.000Z');
      });

      test('a verified claim with no evidence at all is due, and comes first', async () => {
        // The shape a half-finished pass leaves. It is as un-current as one
        // whose evidence expired.
        const { repository } = await open();
        await repository.recordVerification({
          claim: claimFixtureV1({ tokenAddress: OTHER, claimantDomain: 'other.example' }),
          evidence: [],
        });
        await repository.recordVerification({
          claim: claimFixtureV1(),
          evidence: [evidenceFixtureV1({ observedAt: '2026-08-16T11:00:00.000Z' })],
        });
        const due = await repository.claimsDueForReverification({
          chainId: 8453,
          observedBefore: CUTOFF,
          limit: 10,
        });
        assert.deepEqual(
          due.map((entry) => [entry.tokenAddress, entry.oldestObservedAt]),
          [[OTHER, null], [TOKEN, '2026-08-16T11:00:00.000Z']],
        );
      });

      test('a claim that is not verified is never queued', async () => {
        // Re-reading a refuted claim would be spending a request to re-learn
        // something already settled, and would put its domain back on a card.
        const { repository } = await open();
        await repository.recordVerification({
          claim: claimFixtureV1(),
          evidence: [evidenceFixtureV1({ observedAt: '2026-08-16T11:00:00.000Z' })],
        });
        await repository.recordVerification({
          claim: claimFixtureV1({ status: 'refuted', verifiedLinks: [], refutedLinks: ['domain_file'] }),
          evidence: [],
        });
        assert.deepEqual(
          await repository.claimsDueForReverification({ chainId: 8453, observedBefore: CUTOFF, limit: 10 }),
          [],
        );
      });

      test('the queue is bounded', async () => {
        const { repository } = await open();
        for (const [token, domain] of [[TOKEN, 'miorail.xyz'], [OTHER, 'other.example']] as const) {
          await repository.recordVerification({
            claim: claimFixtureV1({ tokenAddress: token, claimantDomain: domain }),
            evidence: [evidenceFixtureV1({ tokenAddress: token, observedAt: '2026-08-16T11:00:00.000Z' })],
          });
        }
        const due = await repository.claimsDueForReverification({
          chainId: 8453,
          observedBefore: CUTOFF,
          limit: 1,
        });
        assert.equal(due.length, 1);
      });
    });
  });
}
