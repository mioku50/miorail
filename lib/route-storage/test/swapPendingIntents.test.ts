import { createMemorySwapPendingIntentRepository } from '../src/swapPendingIntentsMemory.js';
import { swapPendingIntentContractV1 } from './swapPendingIntents.contract.js';

swapPendingIntentContractV1('memory', async () => ({
  repository: createMemorySwapPendingIntentRepository(),
}));
