import { createMemoryB20LaunchBuyersRepository } from '../src/b20LaunchBuyersMemory.js';
import { b20LaunchBuyersContractV1 } from './b20LaunchBuyers.contract.js';

b20LaunchBuyersContractV1('memory', async () => ({
  repository: createMemoryB20LaunchBuyersRepository(),
}));
