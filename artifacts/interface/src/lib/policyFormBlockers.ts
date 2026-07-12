// T44: explains WHY the "Save spending limits" button is disabled. Mirrors the
// exact validation conditions in ConfigureView (limitsValid / addressesValid /
// policyFormValid) as human-readable reasons; pure and unit-testable.

export interface PolicyFormBlockerInput {
  address?: string | null;
  dailyLimit: string;
  maxPerAction: string;
  ttlHours: string;
  whitelist: string[];
  mainnetOptIn: boolean;
  acknowledgeMainnetRisk: boolean;
}

const MIN_TTL_HOURS = 1 / 12; // 5 minutes

export function policyFormBlockers(input: PolicyFormBlockerInput): string[] {
  const blockers: string[] = [];
  if (!input.address) blockers.push('Connect wallet first');

  const dailyLimit = Number(input.dailyLimit);
  const maxPerAction = Number(input.maxPerAction);
  const ttlHours = Number(input.ttlHours);
  if (!(dailyLimit > 0)) blockers.push('Daily limit must be > 0');
  if (!(maxPerAction > 0)) blockers.push('Per-action limit must be > 0');
  if (dailyLimit > 0 && maxPerAction > 0 && maxPerAction > dailyLimit) {
    blockers.push('Per-action limit must not exceed the daily limit');
  }
  if (!(ttlHours >= MIN_TTL_HOURS)) blockers.push('Session TTL must be at least 5 minutes');

  if (input.whitelist.length === 0) {
    blockers.push('Add at least one allowed recipient address');
  } else if (!input.whitelist.every((entry) => /^0x[0-9a-fA-F]{40}$/.test(entry))) {
    blockers.push('Every allowed recipient must be a valid 0x address');
  }

  if (input.mainnetOptIn && !input.acknowledgeMainnetRisk) {
    blockers.push('Acknowledge the mainnet risk checkbox');
  }
  return blockers;
}
