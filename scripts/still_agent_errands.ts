/**
 * One pass of Still Agent's errands: what came due, reminded once. What is
 * said, and how each day is claimed once, is in ./stillAgentErrands.ts.
 *
 * Off unless STILL_AGENT_V1=on. Reads and writes Still Agent's own tables and
 * sends Telegram messages; no signer, no chain write, no invoice. The bot
 * tokens are read from the environment and never printed.
 *
 *   node --import tsx scripts/still_agent_errands.ts --dry    plans, claims and sends nothing
 *   node --import tsx scripts/still_agent_errands.ts
 */
import { client, closeDb } from '@mioagent/db';
import { createDatabaseStillAgentRepositoryV1 } from '@mioagent/route-storage';
import { createTelegramBotClientV1, stillAgentBotConfigV1 } from '@mioagent/telegram';
import { describeErrorV1 } from '@mioagent/utils';

import { stillAgentEnabledV1 } from '../artifacts/api-server/lib/stillAgent.js';
import { runStillAgentErrandsV1 } from './stillAgentErrands.js';

async function main(): Promise<number> {
  const dry = process.argv.includes('--dry');
  if (!stillAgentEnabledV1(process.env)) {
    console.log('still agent errands: off (STILL_AGENT_V1 is not on)');
    return 0;
  }
  const config = stillAgentBotConfigV1(process.env);
  const result = await runStillAgentErrandsV1({
    repository: createDatabaseStillAgentRepositoryV1(client as never),
    config,
    bot: (token) => createTelegramBotClientV1({ token }),
    now: () => new Date(),
    log: (line) => console.log(line),
  }, { dry });
  console.log(`still agent errands: ${dry ? 'dry ' : ''}due=${result.due} claimed=${result.claimed} own_bot=${result.ownBot} agents_bot=${result.agentsBot} `
    + `site_only=${result.siteOnly} paused=${result.paused} late=${result.late} failed=${result.failed} telegram=${config ? 'on' : 'off'}`);
  return 0;
}

main()
  .then(async (code) => {
    await closeDb().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (cause: unknown) => {
    console.error(`still agent errands failed: ${describeErrorV1(cause)}`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
