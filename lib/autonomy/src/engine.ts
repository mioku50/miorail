import { SpendPermission, Call } from './types';

export class AutonomyEngine {
  private permissions: Map<string, SpendPermission> = new Map();

  createPermission(permission: SpendPermission): void {
    this.permissions.set(permission.id, permission);
  }

  getPermission(id: string): SpendPermission | undefined {
    return this.permissions.get(id);
  }

  killSwitch(id: string): void {
    const perm = this.permissions.get(id);
    if (perm) {
      perm.isActive = false;
      this.permissions.set(id, perm);
    }
  }

  // Simplified logic for mock signer, returns a mock approval or throws
  validateAndSign(permissionId: string, calls: Call[], cost: number = 0): { success: boolean; mockSignature?: string; error?: string } {
    const perm = this.permissions.get(permissionId);

    if (!perm) {
      return { success: false, error: 'Permission not found' };
    }

    if (!perm.isActive) {
      return { success: false, error: 'Permission is inactive (kill-switch engaged)' };
    }

    if (Date.now() > perm.expiresAt) {
      return { success: false, error: 'Permission expired' };
    }

    if (perm.spent + cost > perm.limit) {
      return { success: false, error: 'Spend limit exceeded' };
    }

    for (const call of calls) {
      if (!perm.whitelist.includes(call.to.toLowerCase())) {
        return { success: false, error: `Contract ${call.to} is not whitelisted` };
      }
    }

    // Mock signing execution
    perm.spent += cost;
    this.permissions.set(permissionId, perm);

    return { success: true, mockSignature: '0xmocksignature' + Date.now().toString(16) };
  }
}
