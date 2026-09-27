import {
  DividendCalendarAgentInputV1Schema,
  DividendCalendarAgentOutputV1Schema,
  dividendCalendarForAgentV1,
  type DividendCalendarAgentInputV1,
} from '@mioagent/rwa-market-reality/dividend-agent';

import { dividendCalendarForSlotV1, publicStocksRuntime } from '../publicStocks.js';
import { McpPublicError } from './tools.js';

export { DividendCalendarAgentInputV1Schema, DividendCalendarAgentOutputV1Schema };

/**
 * The dividend calendar, on the protocol.
 *
 * The same five-minute calendar the Stocks board and every wallet's own read
 * use, through the same cache, so an assistant and the board cannot state two
 * different next payments for one stock.
 */
export async function miorailGetDividendCalendarV1(input: DividendCalendarAgentInputV1) {
  if (!(await publicStocksRuntime.storageAvailable())) {
    throw new McpPublicError(
      'dividend_calendar_unavailable',
      'Miorail could not read its dividend calendar. This is not a statement about any company: no dividend is established or ruled out by this failure.',
    );
  }
  return dividendCalendarForAgentV1(await dividendCalendarForSlotV1(publicStocksRuntime.now()), input);
}
