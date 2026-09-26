import { TelegramBotErrorV1, createTelegramBotClientV1, telegramConfigV1, telegramWebhookUrlV1 } from '@mioagent/telegram';

import { loadRootEnvFileV1 } from './loadEnvFile.js';

// ---------------------------------------------------------------------------
// Points the Telegram bot's webhook at this deployment. Run by ops/deploy.sh.
//
// Set on every deploy, not only when the URL differs: the secret Telegram
// echoes back is derived from the token, and a token revoked in BotFather
// changes it while the webhook keeps the old one — after which every update
// would be refused, silently. Setting is idempotent and costs one request.
//
// Prints one verdict line, last: `on @name …`, `off …` or `failed …`. Never
// the token, and never a request URL, which contains it.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadRootEnvFileV1();
  const config = telegramConfigV1(process.env);
  if (!config) {
    console.log('off no TELEGRAM_BOT_TOKEN, or MIORAIL_TELEGRAM_V1=off');
    return;
  }
  const bot = createTelegramBotClientV1({ token: config.token });
  try {
    const me = await bot.getMe();
    await bot.setWebhook({ url: telegramWebhookUrlV1(config), secretToken: config.webhookSecret });
    const info = await bot.getWebhookInfo();
    const pointed = info.url === telegramWebhookUrlV1(config) ? 'webhook set' : 'webhook NOT pointed here';
    console.log(`on @${me.username} · ${pointed} · ${info.pendingUpdateCount} pending`);
  } catch (error) {
    console.log(`failed ${error instanceof TelegramBotErrorV1 ? error.message : 'telegram_error'}`);
  }
}

main().catch(() => {
  console.log('failed telegram_error');
});
