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

    test('a bulk read returns only the tokens that have a claim', async () => {
      const { repository } = await open();
      await repository.recordVerification({ claim: claimFixtureV1(), evidence: [evidenceFixtureV1()] });
      const records = await repository.readProjects({ chainId: 8453, tokenAddresses: [TOKEN, OTHER] });
      assert.equal(records.length, 1);
      assert.equal(records[0]?.claim.tokenAddress, TOKEN);
    });
  });
}
