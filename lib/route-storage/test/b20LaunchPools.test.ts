import { createMemoryB20LaunchPoolRepository } from '../src/b20LaunchPoolsMemory.js';
import { b20LaunchPoolContractV1 } from './b20LaunchPools.contract.js';

b20LaunchPoolContractV1('memory', async () => ({
  repository: createMemoryB20LaunchPoolRepository(),
}));
