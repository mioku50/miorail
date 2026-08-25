import { createMemoryMarketTailRepository } from '../src/marketTailMemory.js';
import { marketTailContractV1 } from './marketTail.contract.js';

marketTailContractV1('memory', async () => ({ repository: createMemoryMarketTailRepository() }));
