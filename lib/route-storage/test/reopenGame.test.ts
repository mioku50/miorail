import { InMemoryReopenGameRepositoryV1 } from '../src/reopenGameMemory.js';
import { reopenGameContract } from './reopenGame.contract.js';

reopenGameContract('memory', async () => new InMemoryReopenGameRepositoryV1());
