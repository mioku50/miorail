import { base } from '@base-org/account';
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

  // Prepares execution for autonomous actions within boundaries, integrating
  // actual Base Spend Permissions (subscriptions) for billing, and returning
  // a valid EIP-5792 batch for Base Sepolia (0x14a34) execution.
  async validateAndPrepareExecution(
    permissionId: string,
    calls: Call[],
    cost: number = 0
  ): Promise<{ success: boolean; sendCallsRequest?: any; error?: string }> {
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

    let executionCalls: Call[] = [...calls];

    // Integrate real Spend Permissions: prepare a charge against the subscription
    if (cost > 0) {
      try {
        const chargeCalls = await base.subscription.prepareCharge({
          id: permissionId,
          amount: cost.toString(),
          testnet: true // Enforce Sepolia testnet
        });

        // Ensure the returned structure from prepareCharge matches our Call interface (value needs to be string, not bigint if that is what it returns)
        const mappedChargeCalls: Call[] = chargeCalls.map(c => ({
            to: c.to as string,
            data: c.data as string,
            value: (c.value || '0').toString()
        }));

        executionCalls = [...mappedChargeCalls, ...executionCalls];
      } catch (err: any) {
        return { success: false, error: `Failed to prepare spend permission charge: ${err.message}` };
      }
    }

    perm.spent += cost;
    this.permissions.set(permissionId, perm);

    return {
      success: true,
      sendCallsRequest: {
        version: '2.0.0',
        from: perm.userId,
        chainId: '0x14a34', // Base Sepolia
        atomicRequired: true,
        calls: executionCalls
      }
    };
  }

  async getSubscriptionStatus(subscriptionId: string, testnet: boolean = true) {
    return await base.subscription.getStatus({ id: subscriptionId, testnet });
  }

  async prepareSubscriptionRevoke(subscriptionId: string, testnet: boolean = true) {
    return await base.subscription.prepareRevoke({ id: subscriptionId, testnet });
  }
}
