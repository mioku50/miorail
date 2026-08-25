import { createMemoryOfficialAssetRepository } from '../src/officialAssetsMemory.js';
import { officialAssetContractV1 } from './officialAssets.contract.js';

officialAssetContractV1('memory', async () => ({ repository: createMemoryOfficialAssetRepository() }));
