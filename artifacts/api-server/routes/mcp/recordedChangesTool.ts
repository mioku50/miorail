import {
  RwaRecordedChangesAgentInputV1Schema,
  RwaRecordedChangesAgentOutputV1Schema,
  rwaRecordedChangesForAgentV1,
  type RwaRecordedChangesAgentInputV1,
} from '@mioagent/rwa-dossier';

import { rwaDiscoverRuntime } from '../rwaDiscover.js';
import { McpPublicError } from './tools.js';

export {
  RwaRecordedChangesAgentInputV1Schema,
  RwaRecordedChangesAgentOutputV1Schema,
};

/**
 * The market-wide changes read, on the protocol.
 *
 * It reuses `rwaDiscoverRuntime.deps()` rather than assembling its own, so the
 * tool and the /rwa/signals route read the same repositories through the same
 * builder. The runtime opens a chain reader it does not use here; that is the
 * cost of one dependency set instead of two, and two would be the thing that
 * eventually disagrees.
 */
export async function miorailGetRecordedChangesV1(input: RwaRecordedChangesAgentInputV1) {
  if (!(await rwaDiscoverRuntime.migrationAvailable())) {
    throw new McpPublicError(
      'rwa_signal_storage_unavailable',
      'Miorail could not read its recorded-change store. This is not a statement about the market: no claim about what did or did not change can be made from this failure.',
    );
  }
  return rwaRecordedChangesForAgentV1(rwaDiscoverRuntime.deps(), input);
}
