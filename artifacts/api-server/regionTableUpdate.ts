import { describeErrorV1 } from '@mioagent/utils';
import { STILL_REGION_TABLE_PATH_DEFAULT_V1, STILL_REGISTRY_TABLE_PATH_DEFAULT_V1 } from './lib/stillRegion.js';
import { fetchRegionTableBytesV1, updateStillRegionTableV1 } from './lib/stillRegionTableUpdate.js';
import { updateStillRegistryTableV1 } from './lib/stillRegistryTable.js';

// The region tables' update, as miorail-region-table.service runs it: DB-IP's
// country table each month (lib/stillRegionTableUpdate.ts), then the
// registries' table each week (lib/stillRegistryTable.ts). One line of JSON
// for each; either failing fails the unit and leaves its own table in place.
const path = process.env.STILL_REGION_TABLE_PATH_V1?.trim() || STILL_REGION_TABLE_PATH_DEFAULT_V1;
const registryPath = process.env.STILL_REGISTRY_TABLE_PATH_V1?.trim() || STILL_REGISTRY_TABLE_PATH_DEFAULT_V1;

async function main(): Promise<void> {
  let failed = false;
  try {
    console.log(JSON.stringify({ event: 'still_region_table', ...await updateStillRegionTableV1({ path, now: new Date(), fetch: fetchRegionTableBytesV1 }) }));
  } catch (cause) {
    console.error(JSON.stringify({ event: 'still_region_table_failed', message: describeErrorV1(cause) }));
    failed = true;
  }
  try {
    console.log(JSON.stringify({ event: 'still_registry_table', ...await updateStillRegistryTableV1({ path: registryPath, now: new Date(), fetch: fetchRegionTableBytesV1 }) }));
  } catch (cause) {
    console.error(JSON.stringify({ event: 'still_registry_table_failed', message: describeErrorV1(cause) }));
    failed = true;
  }
  if (failed) process.exitCode = 1;
}
void main();
