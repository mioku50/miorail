import { createMemoryMarketPoolReadingRepository } from '../src/index.js';
import { poolReadingsContract } from './poolReadings.contract.js';

poolReadingsContract('memory', async () => createMemoryMarketPoolReadingRepository());
