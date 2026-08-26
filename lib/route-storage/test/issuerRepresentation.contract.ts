import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { IssuerRepresentationRepositoryV1 } from '../src/issuerRepresentation.js';

/** The measured Dinari Apple dShare and its production factory on Base. */
const DINARI_AAPL = '0x41f7a63713e76c0ab800be03bae9f17b8a356348';
const DINARI_WRAPPED_AAPL = '0x052175b0015ccca91919f374043a665441e4b0b8';
const PRODUCTION_ROOT = '0xbce6410a175a1c9b1a25d38d7e1a900f8393bc4d';
const STAGING_ROOT = '0x4cdbd5a0938be8c57ded76880f774db67dc915a9';

const HASH_A = `0x${'a1'.repeat(32)}`;
const HASH_B = `0x${'b2'.repeat(32)}`;
const EV_A = `0x${'e1'.repeat(32)}`;
const EV_B = `0x${'e2'.repeat(32)}`;

/**
 * The contract both repositories are held to.
 *
 * Every case is a way this registry could vouch for the wrong thing: a cold
 * start announced as fifty issuer events, an outage stored as a refutation,
 * one environment's answer read as the other's, a wrapper adopted because it
 * sits next to a member.
 */
export function issuerRepresentationContractV1(
  label: string,
  open: () => Promise<{ repository: IssuerRepresentationRepositoryV1 }>,
): void {
  const membership = (
    over: Partial<Parameters<IssuerRepresentationRepositoryV1['recordMembership']>[0]> = {},
  ) => ({
    chainId: 8453,
    tokenAddress: DINARI_AAPL,
    issuerId: 'dinari' as const,
    rootKey: 'dinari_dshare_factory_v0_4_0_production',
    rootAddress: PRODUCTION_ROOT,
    membership: 'established' as const,
    blockNumber: '50487393',
    blockHash: HASH_A,
    evidenceHash: EV_A,
    observedAt: '2026-08-26T12:00:00.000Z',
    ...over,
  });

  const check = (
    over: Partial<Parameters<IssuerRepresentationRepositoryV1['recordCheck']>[0]> = {},
  ) => ({
    issuerId: 'dinari' as const,
    rootKey: 'dinari_dshare_factory_v0_4_0_production',
    chainId: 8453 as const,
    rootAddress: PRODUCTION_ROOT,
    predicateSelector: '0x25f28f16',
    status: 'ok' as const,
    blockNumber: '50487393',
    blockHash: HASH_A,
    candidates: 2,
    established: 1,
    refuted: 1,
    unread: 0,
    observedAt: '2026-08-26T12:00:00.000Z',
    detail: null,
    ...over,
  });

  describe(`issuer representation (${label})`, () => {
    test('the first sighting is not an issuer event', async () => {
      const { repository } = await open();
      const first = await repository.recordMembership(membership());
      assert.equal(first.outcome, 'first_observation');
      assert.equal(first.row.changes, 0);
      assert.equal(first.row.lastChangedAt, null);
      assert.equal(first.row.reads, 1);
    });

    test('a refutation is stored, because it is an answer', async () => {
      // The wrapper sits beside every dShare and the factory says no about it.
      // That "no" is a fact worth keeping: it is what stops the wrapper from
      // being adopted later on the grounds that nothing has ruled it out.
      const { repository } = await open();
      const { row } = await repository.recordMembership(
        membership({ tokenAddress: DINARI_WRAPPED_AAPL, membership: 'refuted', evidenceHash: EV_B }),
      );
      assert.equal(row.membership, 'refuted');
      const established = await repository.establishedRepresentations({ chainId: 8453, limit: 50 });
      assert.deepEqual(established, [], 'a refuted address is never in the established set');
    });

    test('two roots of one issuer keep separate answers about one address', async () => {
      // Measured 2026-08-26: the production factory says true about the Apple
      // dShare and the v1.0.0 STAGING factory on the same chain says false.
      // Collapsing the two would make the newer contract look like a delisting.
      const { repository } = await open();
      await repository.recordMembership(membership());
      await repository.recordMembership(
        membership({
          rootKey: 'dinari_dshare_factory_v1_0_0_staging',
          rootAddress: STAGING_ROOT,
          membership: 'refuted',
          evidenceHash: EV_B,
        }),
      );
      const rows = await repository.membershipFor({ chainId: 8453, tokenAddresses: [DINARI_AAPL] });
      assert.equal(rows.length, 2, 'one address, two roots, two rows');
      const byRoot = new Map(rows.map((row) => [row.rootKey, row.membership]));
      assert.equal(byRoot.get('dinari_dshare_factory_v0_4_0_production'), 'established');
      assert.equal(byRoot.get('dinari_dshare_factory_v1_0_0_staging'), 'refuted');
      // And neither of them counted as a change to the other.
      assert.deepEqual(
        rows.map((row) => row.changes),
        [0, 0],
      );
    });

    test('an answer that moved is a change, and it carries a time', async () => {
      const { repository } = await open();
      await repository.recordMembership(membership());
      const moved = await repository.recordMembership(
        membership({
          membership: 'refuted',
          blockNumber: '50490000',
          blockHash: HASH_B,
          evidenceHash: EV_B,
          observedAt: '2026-08-27T12:00:00.000Z',
        }),
      );
      assert.equal(moved.outcome, 'changed');
      assert.equal(moved.row.changes, 1);
      assert.equal(moved.row.lastChangedAt, '2026-08-27T12:00:00.000Z');
      assert.equal(moved.row.firstSeenAt, '2026-08-26T12:00:00.000Z', 'first seen never resets');
    });

    test('an unchanged answer moves the clock and claims nothing', async () => {
      const { repository } = await open();
      await repository.recordMembership(membership());
      const again = await repository.recordMembership(
        membership({ blockNumber: '50490000', blockHash: HASH_B, observedAt: '2026-08-27T12:00:00.000Z' }),
      );
      assert.equal(again.outcome, 'unchanged');
      assert.equal(again.row.lastCheckedAt, '2026-08-27T12:00:00.000Z');
      assert.equal(again.row.lastChangedAt, null);
      assert.equal(again.row.changes, 0);
      assert.equal(again.row.reads, 2);
    });

    test('an address nobody asked about has no row', async () => {
      const { repository } = await open();
      await repository.recordMembership(membership());
      const rows = await repository.membershipFor({
        chainId: 8453,
        tokenAddresses: [DINARI_AAPL, DINARI_WRAPPED_AAPL],
      });
      assert.deepEqual(
        rows.map((row) => row.tokenAddress),
        [DINARI_AAPL],
        'the unasked address is absent, not refuted',
      );
    });

    test('a check that did not complete is stored, and decides nothing', async () => {
      const { repository } = await open();
      const failed = await repository.recordCheck(
        check({
          status: 'endpoint_unavailable',
          blockNumber: null,
          blockHash: null,
          candidates: 13,
          established: 0,
          refuted: 0,
          unread: 13,
          detail: 'the endpoint refused every call in this pass',
        }),
      );
      assert.equal(failed.status, 'endpoint_unavailable');
      assert.equal(failed.unread, 13);
      // It is the newest check, and it is NOT the newest successful one.
      const newest = await repository.latestCheck({
        issuerId: 'dinari',
        rootKey: 'dinari_dshare_factory_v0_4_0_production',
      });
      assert.equal(newest?.status, 'endpoint_unavailable');
      const newestOk = await repository.latestCheck({
        issuerId: 'dinari',
        rootKey: 'dinari_dshare_factory_v0_4_0_production',
        successfulOnly: true,
      });
      assert.equal(newestOk, null, 'freshness comes from a check that completed');
    });

    test('a failed check cannot smuggle in a decision', async () => {
      const { repository } = await open();
      await assert.rejects(
        () => repository.recordCheck(check({ status: 'root_unreadable', established: 1, refuted: 0, unread: 1 })),
        /decided nothing/,
      );
    });

    test('every candidate lands in exactly one bucket', async () => {
      const { repository } = await open();
      await assert.rejects(
        () => repository.recordCheck(check({ candidates: 5, established: 1, refuted: 1, unread: 0 })),
        /exactly one of established, refuted or unread/,
      );
    });
  });
}
