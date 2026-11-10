import { STILL_REGION_TABLE_PATH_DEFAULT_V1 } from './lib/stillRegion.js';
import { fetchRegionTableBytesV1, updateStillRegionTableV1 } from './lib/stillRegionTableUpdate.js';

// The monthly region table update, as miorail-region-table.service runs it
// (lib/stillRegionTableUpdate.ts). One line of JSON on success; a failure
// fails the unit and leaves the table in place.
const path = process.env.STILL_REGION_TABLE_PATH_V1?.trim() || STILL_REGION_TABLE_PATH_DEFAULT_V1;
updateStillRegionTableV1({ path, now: new Date(), fetch: fetchRegionTableBytesV1 })
  .then(result => { console.log(JSON.stringify({ event: 'still_region_table', ...result })); })
  .catch((cause: unknown) => {
    console.error(JSON.stringify({ event: 'still_region_table_failed', message: cause instanceof Error ? cause.message : String(cause) }));
    process.exitCode = 1;
  });
