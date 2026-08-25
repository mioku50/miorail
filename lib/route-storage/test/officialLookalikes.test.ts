import { createMemoryOfficialLookalikeRepository } from '../src/officialLookalikesMemory.js';
import { officialLookalikeContractV1 } from './officialLookalikes.contract.js';

officialLookalikeContractV1('memory', async () => ({
  repository: createMemoryOfficialLookalikeRepository(),
}));
