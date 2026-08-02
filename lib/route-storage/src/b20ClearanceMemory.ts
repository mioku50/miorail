import {
  assertClearanceV1,
  clearanceConflictV1,
  type B20ClearanceRepositoryV1,
  type B20OpportunityClearanceV1,
} from './b20Clearance.js';

/**
 * The in-memory clearance store.
 *
 * Same immutability rule and same ordering as Postgres. A fake that let a
 * clearance be overwritten would hide the one failure that matters: a record
 * justifying an execution changing under that execution.
 */
export class InMemoryB20ClearanceRepositoryV1 implements B20ClearanceRepositoryV1 {
  private readonly rows = new Map<string, B20OpportunityClearanceV1>();

  async insertClearance(clearance: B20OpportunityClearanceV1): Promise<B20OpportunityClearanceV1> {
    const parsed = assertClearanceV1(clearance, 'write');
    const existing = this.rows.get(parsed.id);
    if (existing) {
      // Byte-identical is an ordinary retry. Anything else is two records
      // claiming the same id, and neither silently wins.
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return existing;
      throw clearanceConflictV1('A different clearance already exists with this id');
    }
    this.rows.set(parsed.id, parsed);
    return parsed;
  }

  async getClearance(id: string, tenantId: string): Promise<B20OpportunityClearanceV1 | null> {
    const row = this.rows.get(id);
    // Tenant isolation is a filter, not a check the caller is trusted to make.
    if (!row || row.tenantId !== tenantId) return null;
    return assertClearanceV1(row, 'read');
  }

  async latestClearance(input: {
    tenantId: string;
    walletAddress: string;
    tokenAddress: string;
    profileIdentity: string;
    now: Date;
  }): Promise<B20OpportunityClearanceV1 | null> {
    const wallet = input.walletAddress.toLowerCase();
    const token = input.tokenAddress.toLowerCase();
    const live = [...this.rows.values()]
      .filter(
        (row) =>
          row.tenantId === input.tenantId &&
          row.walletAddress.toLowerCase() === wallet &&
          row.tokenAddress.toLowerCase() === token &&
          row.profileIdentity === input.profileIdentity &&
          Date.parse(row.expiresAt) > input.now.getTime(),
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.id.localeCompare(left.id),
      );
    const row = live[0];
    return row ? assertClearanceV1(row, 'read') : null;
  }
}
