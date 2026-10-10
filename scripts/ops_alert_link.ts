/**
 * Issues the one-time link that turns service alerts on in the Telegram chat
 * that opens it (scripts/ops_unit_alerts.ts sends them). Run on the server by
 * the operator: the link works once, for ten minutes, and only its hash is
 * stored. The bot token is never printed.
 *
 *   node --import tsx scripts/ops_alert_link.ts
 */
import { client, closeDb } from '@mioagent/db';
import { createDatabaseOpsAlertChatRepositoryV1 } from '@mioagent/route-storage';
import {
  TELEGRAM_LINK_TTL_MS_V1,
  createTelegramBotClientV1,
  newTelegramLinkCodeV1,
  telegramConfigV1,
  telegramOpsAlertStartUrlV1,
} from '@mioagent/telegram';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

async function main(): Promise<void> {
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const config = telegramConfigV1(process.env);
  if (!config) {
    console.error('TELEGRAM_BOT_TOKEN is not set: there is no bot to send service alerts.');
    process.exitCode = 1;
    return;
  }
  const { username } = await createTelegramBotClientV1({ token: config.token }).getMe();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS_V1);
  const { code, hash } = newTelegramLinkCodeV1();
  const chats = createDatabaseOpsAlertChatRepositoryV1(client);
  await chats.pruneCodes({ before: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
  await chats.issueCode({ codeHash: hash, now, expiresAt });
  console.log('Open this in the Telegram chat that should hear service alerts, and press Start.');
  console.log(`It works once, until ${expiresAt.toISOString()}:`);
  console.log(telegramOpsAlertStartUrlV1(username, code));
}

main()
  .catch((error) => {
    console.error('service alert link failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
