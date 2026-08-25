import { createMemoryRwaSignalRepository } from '../src/rwaSignalsMemory.js';
import { rwaSignalContractV1 } from './rwaSignals.contract.js';

rwaSignalContractV1('memory', async () => ({ repository: createMemoryRwaSignalRepository() }));
