import { createMemoryB20ProjectRepository } from '../src/b20ProjectsMemory.js';
import { b20ProjectContractV1 } from './b20Projects.contract.js';

b20ProjectContractV1('memory', async () => ({ repository: createMemoryB20ProjectRepository() }));
