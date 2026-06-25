export interface BudgetEntry {
  actionId: string;
  cost: bigint;
  txHash?: string;
  timestamp: Date;
}

export class BudgetGuard {
  constructor(private budgetEntries: BudgetEntry[] = []) {}

  // action -> cost -> tx-hash
  addEntry(entry: BudgetEntry): void {
    this.budgetEntries.push(entry);
  }

  getEntries(): BudgetEntry[] {
    return [...this.budgetEntries];
  }

  exportLedger(): string {
    return this.budgetEntries
      .map(entry => `${entry.timestamp.toISOString()} - Action: ${entry.actionId}, Cost: ${entry.cost.toString()}, Tx: ${entry.txHash || 'N/A'}`)
      .join('\n');
  }
}
