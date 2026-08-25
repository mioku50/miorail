import { createMemoryWatchScheduleRepository } from '../src/watchScheduleMemory.js';
import { watchScheduleContractV1 } from './watchSchedule.contract.js';

watchScheduleContractV1('memory', async () => ({
  repository: createMemoryWatchScheduleRepository(),
}));
