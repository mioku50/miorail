import {
  ReopenRoundAgentInputV1Schema,
  ReopenRoundAgentOutputV1Schema,
  reopenRoundForAgentV1,
} from '@mioagent/rwa-market-reality/reopen-agent';
import { reopenGameForV1 } from '@mioagent/rwa-market-reality/reopen-game-service';

import { reopenGameRuntime, reopenSharedNowV1 } from '../reopenGame.js';
import { McpPublicError } from './tools.js';

export { ReopenRoundAgentInputV1Schema, ReopenRoundAgentOutputV1Schema };

/**
 * Call the reopen, on the protocol: this weekend's round, its result, or when
 * the next opens.
 *
 * The same thirty-second read the Weekend tab makes, through the same cache,
 * with nobody's picks in it. This surface takes no player and makes no pick:
 * a pick belongs to a person, and the connected surface is where a grant names
 * one.
 */
export async function miorailGetReopenRoundV1() {
  if (!reopenGameRuntime.enabled(process.env) || !(await reopenGameRuntime.storageAvailable())) {
    throw new McpPublicError(
      'reopen_game_unavailable',
      'Miorail could not read Call the reopen right now. This says nothing about any stock or any round.',
    );
  }
  const now = reopenGameRuntime.now();
  const shared = await reopenSharedNowV1(now);
  const response = await reopenGameForV1({ shared, player: null, now, repository: reopenGameRuntime.repository() });
  return reopenRoundForAgentV1(response);
}
