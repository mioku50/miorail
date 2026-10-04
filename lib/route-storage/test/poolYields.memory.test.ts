import { createMemoryPoolYieldReadingRepository } from '../src/index.js';
import { poolYieldsContract } from './poolYields.contract.js';

poolYieldsContract('memory', async () => createMemoryPoolYieldReadingRepository());
