import { createMemoryStockInboxRepositoryV1 } from '../src/stockInboxMemory.js';
import type { RwaSignalRowV1 } from '../src/rwaSignals.js';
import { stockInboxContract } from './stockInbox.contract.js';
stockInboxContract('memory', async () => {
  const rows: RwaSignalRowV1[] = [];
  return {
    repository: createMemoryStockInboxRepositoryV1(() => rows),
    async add(next) {
      rows.push(...next);
    },
  };
});
