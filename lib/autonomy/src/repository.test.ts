import test from 'node:test';
import assert from 'node:assert';
import {
  InMemorySpendPermissionRepository,
  createDatabaseSpendPermissionRepository,
  type ConfirmedSettlementProof,
  type SqlTemplateExecutor,
} from './repository';

// Audit fix: incrementSpent must be idempotent by settlement proof. The Neon
// HTTP driver's customFetch retries any fetch failure (including
// AbortController timeouts) up to DATABASE_FETCH_ATTEMPTS times; a single SQL
// statement can be re-sent after it already committed. Without a proof-keyed
// ledger, that retry would double-increment `spent` for the same real-world
// charge.

test('InMemorySpendPermissionRepository.incrementSpent: same proof applies once, different proofs apply twice, over-limit is rejected', async () => {
  const repository = new InMemorySpendPermissionRepository();
  await repository.create({
    id: 'perm1',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 60_000,
    isActive: true,
  });

  const proofA: ConfirmedSettlementProof = { txHash: '0xaaa' };
  const first = await repository.incrementSpent('perm1', 40, proofA);
  assert.strictEqual(first?.spent, 40);

  // Retried call with the identical proof (simulating a customFetch retry after
  // the first UPDATE already committed): must not double-increment.
  const retry = await repository.incrementSpent('perm1', 40, proofA);
  assert.ok(retry, 'retry with the same proof should be treated as idempotent success');
  assert.strictEqual(retry?.spent, 40, 'spent must not be incremented again for a repeated proof');

  // A genuinely different settlement (different proof) increments again.
  const proofB: ConfirmedSettlementProof = { txHash: '0xbbb' };
  const second = await repository.incrementSpent('perm1', 30, proofB);
  assert.strictEqual(second?.spent, 70);

  // Exceeding the remaining limit is rejected, proof or not.
  const proofC: ConfirmedSettlementProof = { txHash: '0xccc' };
  const rejected = await repository.incrementSpent('perm1', 40, proofC);
  assert.strictEqual(rejected, undefined);

  const stored = await repository.getById('perm1');
  assert.strictEqual(stored?.spent, 70, 'rejected over-limit call must not have touched spent');
});

test('InMemorySpendPermissionRepository.incrementSpent: an over-limit rejection is not recorded, so a retry with the same proof is rejected again', async () => {
  const repository = new InMemorySpendPermissionRepository();
  await repository.create({
    id: 'perm-reject',
    userId: 'user1',
    limit: 100,
    spent: 90,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 60_000,
    isActive: true,
  });

  const proof: ConfirmedSettlementProof = { txHash: '0xover' };
  // 90 + 20 > 100 -> rejected, and the proof must NOT be recorded as applied.
  const rejected = await repository.incrementSpent('perm-reject', 20, proof);
  assert.strictEqual(rejected, undefined);

  // Retry of the rejected attempt with the same proof: still a rejection, never
  // a false "already applied" success.
  const retryRejected = await repository.incrementSpent('perm-reject', 20, proof);
  assert.strictEqual(retryRejected, undefined, 'retry of a limit-rejected attempt must stay rejected');

  const stored = await repository.getById('perm-reject');
  assert.strictEqual(stored?.spent, 90, 'a rejected attempt must not have touched spent');
});

test('InMemorySpendPermissionRepository.incrementSpent throws without a durable proof field', async () => {
  const repository = new InMemorySpendPermissionRepository();
  await repository.create({
    id: 'perm-no-proof',
    userId: 'user1',
    limit: 100,
    spent: 0,
    whitelist: ['0xallowed'],
    expiresAt: Date.now() + 60_000,
    isActive: true,
  });

  await assert.rejects(() => repository.incrementSpent('perm-no-proof', 10, {}));
});

// A minimal fake SQL executor that simulates exactly the two query shapes used
// by createDatabaseSpendPermissionRepository: the incrementSpent CTE (a gated
// UPDATE whose proof INSERT is derived ONLY from a successful update row) and
// the plain getById SELECT. This lets us exercise the CTE's
// success/idempotent/rejected classification without a real Postgres instance.
//
// Placeholder order in the inverted CTE statement:
//   [amount(SET), id, amount(limit), key(NOT EXISTS), key(ins SELECT),
//    amount(ins SELECT), key(previously_applied EXISTS)]
function createFakeSql(): { sql: SqlTemplateExecutor; permission: Record<string, unknown> } {
  const permission: Record<string, unknown> = {
    id: 'db-perm1',
    user_id: 'user1',
    chain_id: 8453,
    asset: null,
    limit: 100,
    spent: 0,
    whitelist: [],
    expires_at: new Date(),
    is_active: true,
  };
  const proofs = new Set<string>();

  const sql: SqlTemplateExecutor = async (strings, ...values) => {
    const text = strings.join('¶');
    if (text.includes('WITH upd AS') && text.includes('INSERT INTO spend_permission_proofs')) {
      const amount = values[0] as number;
      const id = values[1] as string;
      const key = values[3] as string;

      // Snapshot semantics: previously_applied reflects the ledger state
      // BEFORE this statement, exactly like a same-snapshot EXISTS in Postgres.
      const previouslyApplied = proofs.has(key);
      const eligible = !previouslyApplied
        && permission.id === id
        && permission.is_active === true
        && (permission.spent as number) + amount <= (permission.limit as number);

      if (eligible) {
        permission.spent = (permission.spent as number) + amount;
        // ins CTE fires only from the successful upd row.
        proofs.add(key);
        return [{ applied: 1, previously_applied: false, ...permission }];
      }
      return [{
        applied: 0,
        previously_applied: previouslyApplied,
        id: null, user_id: null, chain_id: null, asset: null,
        limit: null, spent: null, whitelist: null, expires_at: null, is_active: null,
      }];
    }
    if (text.includes('FROM spend_permissions') && text.includes('WHERE id =')) {
      const [id] = values as [string];
      return permission.id === id ? [{ ...permission }] : [];
    }
    throw new Error(`Unhandled fake SQL query: ${text}`);
  };

  return { sql, permission };
}

test('DB-backed incrementSpent CTE: same proof is idempotent, different proofs apply twice, over-limit rejected', async () => {
  const { sql, permission } = createFakeSql();
  const repository = createDatabaseSpendPermissionRepository(sql);

  const proofA: ConfirmedSettlementProof = { txHash: '0xaaa' };
  const first = await repository.incrementSpent('db-perm1', 40, proofA);
  assert.strictEqual(first?.spent, 40);

  const retry = await repository.incrementSpent('db-perm1', 40, proofA);
  assert.ok(retry, 'retried call with the same proof must report idempotent success');
  assert.strictEqual(retry?.spent, 40, 'spent must not be incremented again for a repeated proof');
  assert.strictEqual(permission.spent, 40, 'underlying row must only have been updated once');

  const proofB: ConfirmedSettlementProof = { txHash: '0xbbb' };
  const second = await repository.incrementSpent('db-perm1', 30, proofB);
  assert.strictEqual(second?.spent, 70);

  const proofC: ConfirmedSettlementProof = { txHash: '0xccc' };
  const rejected = await repository.incrementSpent('db-perm1', 40, proofC);
  assert.strictEqual(rejected, undefined);
  assert.strictEqual(permission.spent, 70, 'rejected over-limit call must not have touched spent');
});

test('DB-backed incrementSpent CTE: an over-limit rejection is not recorded, so a retry with the same proof is rejected again', async () => {
  const { sql, permission } = createFakeSql();
  permission.spent = 90; // remaining headroom = 10
  const repository = createDatabaseSpendPermissionRepository(sql);

  const proof: ConfirmedSettlementProof = { txHash: '0xover' };
  // 90 + 20 > 100 -> rejected; because the proof INSERT is derived only from a
  // successful UPDATE, no ledger row is written for this rejection.
  const rejected = await repository.incrementSpent('db-perm1', 20, proof);
  assert.strictEqual(rejected, undefined);
  assert.strictEqual(permission.spent, 90, 'a rejected attempt must not have touched spent');

  // Retry with the same proof: previously_applied is still false, so this is
  // classified as a genuine rejection, NOT a false "already applied" success.
  const retryRejected = await repository.incrementSpent('db-perm1', 20, proof);
  assert.strictEqual(retryRejected, undefined, 'retry of a limit-rejected attempt must stay rejected');
  assert.strictEqual(permission.spent, 90, 'retry must not have touched spent either');
});
