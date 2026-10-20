import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StockActionExecutionRepositoryV1 } from '../src/stockActionExecutions.js';

const WALLET = `0x${'1'.repeat(40)}`;
const OTHER = `0x${'2'.repeat(40)}`;
const OWNER = { tenantId: `eip155:8453:${WALLET}`, walletAddress: WALLET, actionDraftId: 'draft-1' };
const FOREIGN = { tenantId: `eip155:8453:${OTHER}`, walletAddress: OTHER, actionDraftId: 'draft-1' };
const NOW = new Date('2026-10-20T12:00:00.000Z');
const release = (blueprintId = 'bp-1') => ({ ...OWNER, clearanceId: `clearance-${blueprintId}`,
  blueprintId, routeRunId: `run-${blueprintId}`, at: NOW });

export function stockActionExecutionContract(name: string, make: () => Promise<StockActionExecutionRepositoryV1>) {
  describe(`stock draft to proof (${name})`, () => {
    test('an owned draft without release differs from a foreign or unknown draft', async () => {
      const repo = await make();
      await repo.recordDraft({ ...OWNER, at: NOW });
      assert.deepEqual(await repo.latest(OWNER), { ...OWNER, release: null, createdAt: NOW.toISOString() });
      assert.equal(await repo.latest(FOREIGN), null);
      assert.equal(await repo.latest({ ...OWNER, actionDraftId: 'missing' }), null);
    });
    test('both identity fields are scoped and cannot be replaced by a second owner', async () => {
      const repo = await make();
      await repo.recordDraft({ ...OWNER, at: NOW });
      await assert.rejects(repo.recordDraft({ ...FOREIGN, at: NOW }));
      await assert.rejects(repo.recordRelease({ ...release(), ...FOREIGN }));
      await assert.rejects(repo.latest({ ...OWNER, walletAddress: OTHER }));
      assert.equal((await repo.latest(OWNER))!.release, null);
    });
    test('release persists the link even for a draft created outside MCP', async () => {
      const repo = await make();
      const input = release();
      await repo.recordRelease(input);
      const { at: _at, ...expected } = input;
      assert.deepEqual((await repo.latest(OWNER))!.release, expected);
      assert.equal(await repo.latest(FOREIGN), null);
    });
    test('a retry keeps the original release and cannot overwrite references', async () => {
      const repo = await make();
      await repo.recordRelease(release());
      await repo.recordRelease({ ...release(), at: new Date(NOW.getTime() + 1000) });
      assert.equal((await repo.latest(OWNER))!.createdAt, NOW.toISOString());
      await assert.rejects(repo.recordRelease({ ...release(), routeRunId: 'another-run' }));
      await assert.rejects(repo.recordRelease({ ...release(), clearanceId: 'another-clearance' }));
      assert.equal((await repo.latest(OWNER))!.release!.routeRunId, 'run-bp-1');
    });
    test('latest release wins, including equal-time releases; retrying an older one does not move it', async () => {
      const repo = await make();
      await repo.recordRelease(release());
      await repo.recordRelease(release('bp-2'));
      await repo.recordRelease({ ...release(), at: new Date(NOW.getTime() + 10_000) });
      await repo.recordDraft({ ...OWNER, at: new Date(NOW.getTime() + 20_000) });
      assert.equal((await repo.latest(OWNER))!.release!.blueprintId, 'bp-2');
      await repo.recordRelease({ ...release('bp-3'), at: new Date(NOW.getTime() + 30_000) });
      assert.equal((await repo.latest(OWNER))!.release!.blueprintId, 'bp-3');
    });
    test('a read is a detached value and carries no signed or executable object', async () => {
      const repo = await make();
      await repo.recordRelease(release());
      const row = (await repo.latest(OWNER))!;
      assert.deepEqual(Object.keys(row).sort(), ['actionDraftId', 'createdAt', 'release', 'tenantId', 'walletAddress']);
      assert.deepEqual(Object.keys(row.release!).sort(), ['actionDraftId', 'blueprintId', 'clearanceId', 'routeRunId', 'tenantId', 'walletAddress']);
      row.release!.blueprintId = 'mutated';
      assert.equal((await repo.latest(OWNER))!.release!.blueprintId, 'bp-1');
    });
    test('concurrent retries keep one immutable release', async () => {
      const repo = await make();
      await Promise.all(Array.from({ length: 4 }, () => repo.recordRelease(release())));
      assert.equal((await repo.latest(OWNER))!.release!.blueprintId, 'bp-1');
      await assert.rejects(repo.recordRelease({ ...release(), actionDraftId: 'another-draft' }));
    });
  });
}
