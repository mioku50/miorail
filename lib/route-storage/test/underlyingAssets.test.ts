import { createMemoryUnderlyingAssetRepository } from '../src/underlyingAssetsMemory.js';
import { underlyingAssetContractV1 } from './underlyingAssets.contract.js';

underlyingAssetContractV1('memory', async () => ({
  repository: createMemoryUnderlyingAssetRepository(),
}));
