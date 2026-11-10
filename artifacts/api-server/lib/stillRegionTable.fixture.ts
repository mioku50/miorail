import { buildStillRegionTableV1, parseStillRegionTableV1 } from './stillRegionTable.js';

// A synthetic database in DB-IP's CSV shape: every address, in order, with no
// gap; reserved and private space is `ZZ`. None of these countries is real.
export const SYNTHETIC_REGION_CSV_V1 = [
  '0.0.0.0,7.255.255.255,ZZ',
  '8.0.0.0,8.255.255.255,US',
  '9.0.0.0,9.255.255.255,PR',
  '10.0.0.0,10.255.255.255,ZZ',
  '11.0.0.0,126.255.255.255,DE',
  '127.0.0.0,127.255.255.255,ZZ',
  '128.0.0.0,255.255.255.255,FR',
  '::,2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff,ZZ',
  '2001::,2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff,US',
  '2002::,ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,DE',
].join('\n');

/** The synthetic database as the table the API reads. */
export const syntheticRegionTableV1 = () => parseStillRegionTableV1(buildStillRegionTableV1(SYNTHETIC_REGION_CSV_V1, '2026-11'));
