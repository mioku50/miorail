import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { client } from '@mioagent/db';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { createDatabaseTelegramLinkRepositoryV1, type TelegramLinkRepositoryV1 } from '@mioagent/route-storage';
import {
  TELEGRAM_LINK_TTL_MS_V1,
  TELEGRAM_REPLIES_V1,
  TelegramBotErrorV1,
  createTelegramBotClientV1,
  newTelegramLinkCodeV1,
  telegramCommandV1,
  telegramConfigV1,
  telegramLinkCodeHashV1,
  telegramStartUrlV1,
  type TelegramBotClientV1,
  type TelegramCommandV1,
  type TelegramConfigV1,
} from '@mioagent/telegram';
import { tenantUserFromRequest } from '../middleware/tenantAuth';

// ---------------------------------------------------------------------------
// Telegram: the bot's webhook, and the website's "Connect Telegram".
//
// The webhook is public — Telegram has no session — and is told apart from
// anybody else posting to it by the secret Telegram echoes back, derived from
// the bot token. It answers four commands in a private chat and ignores
// everything else.
//
// The link routes sit behind the session. The only way to join a chat to a
// wallet is a one-time code issued here, to a session that already proved that
// wallet; nothing in any request names a wallet, so there is no request shape
// that connects somebody else's.
//
// No chat id and no wallet is logged: which Telegram account follows which
// wallet is exactly what this must not leak.
// ---------------------------------------------------------------------------

export const telegramRuntime = {
  config: (): TelegramConfigV1 | null => telegramConfigV1(process.env),
  links: (): TelegramLinkRepositoryV1 => createDatabaseTelegramLinkRepositoryV1(client as never),
  bot: (config: TelegramConfigV1): TelegramBotClientV1 => createTelegramBotClientV1({ token: config.token }),
  now: () => new Date(),
  newCode: newTelegramLinkCodeV1,
};

const issueLimiter = new InMemoryRateLimiter({ windowMs: 60 * 60 * 1000, max: 12 });

/** The bot's @username, asked once per token per process. */
let usernameOf: { token: string; username: Promise<string> } | null = null;
function botUsernameV1(config: TelegramConfigV1): Promise<string> {
  if (!usernameOf || usernameOf.token !== config.token) {
    const username = telegramRuntime
      .bot(config)
      .getMe()
      .then((me) => me.username);
    usernameOf = { token: config.token, username };
    // A failed ask is not remembered: the next click asks again.
    username.catch(() => {
      if (usernameOf?.username === username) usernameOf = null;
    });
  }
  return usernameOf.username;
}

/** Test seam: forget the remembered @username. */
export function resetTelegramBotUsernameV1(): void {
  usernameOf = null;
}

function secretMatchesV1(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function failureCodeV1(cause: unknown): string {
  if (cause instanceof TelegramBotErrorV1) return cause.message;
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'error';
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

export const telegramWebhookRouter = Router();

type AnsweredCommandV1 = Exclude<TelegramCommandV1, { kind: 'ignored' }>;

async function answerV1(
  command: AnsweredCommandV1,
  config: TelegramConfigV1,
  links: TelegramLinkRepositoryV1,
): Promise<{ outcome: string; html: string; button?: { text: string; url: string } }> {
  const now = telegramRuntime.now();
  switch (command.kind) {
    case 'start': {
      if (command.code === null) {
        const wallets = await links.walletsOfChat(command.chatId);
        return wallets.length > 0
          ? { outcome: 'status', html: TELEGRAM_REPLIES_V1.status(wallets) }
          : {
              outcome: 'how_to_connect',
              html: TELEGRAM_REPLIES_V1.howToConnect,
              button: { text: 'Open Miorail', url: `${config.origin}/stocks` },
            };
      }
      const codeHash = telegramLinkCodeHashV1(command.code);
      const redeemed = codeHash ? await links.redeemCode({ codeHash, chatId: command.chatId, now }) : null;
      if (!redeemed) return { outcome: 'code_refused', html: TELEGRAM_REPLIES_V1.expired };
      if (!redeemed.linkedNow) return { outcome: 'already_linked', html: TELEGRAM_REPLIES_V1.alreadyConnected(redeemed.walletAddress) };
      return {
        outcome: 'linked',
        html: TELEGRAM_REPLIES_V1.connected(await links.walletsOfChat(command.chatId)),
        button: { text: 'Open Miorail', url: `${config.origin}/stocks` },
      };
    }
    case 'stop': {
      const removed = await links.unlinkChat(command.chatId);
      return removed > 0
        ? { outcome: 'stopped', html: TELEGRAM_REPLIES_V1.stopped }
        : { outcome: 'nothing_to_stop', html: TELEGRAM_REPLIES_V1.nothingToStop };
    }
    case 'status':
      return { outcome: 'status', html: TELEGRAM_REPLIES_V1.status(await links.walletsOfChat(command.chatId)) };
    case 'help':
      return { outcome: 'help', html: TELEGRAM_REPLIES_V1.help };
  }
}

telegramWebhookRouter.post('/webhook', async (req: Request, res: Response) => {
  const config = telegramRuntime.config();
  if (!config) {
    res.status(404).json({ error: 'telegram_unavailable', code: 'telegram_unavailable' });
    return;
  }
  if (!secretMatchesV1(req.get('x-telegram-bot-api-secret-token') ?? '', config.webhookSecret)) {
    res.status(401).json({ error: 'telegram_webhook_refused', code: 'telegram_webhook_refused' });
    return;
  }
  const command = telegramCommandV1(req.body);
  // Always 200 to Telegram once the secret matched: a retried /start would
  // find its code spent and tell the person it had expired.
  if (command.kind === 'ignored') {
    res.status(200).json({ ok: true });
    return;
  }
  let answer: Awaited<ReturnType<typeof answerV1>>;
  try {
    answer = await answerV1(command, config, telegramRuntime.links());
  } catch (cause) {
    logger.warn('Telegram command failed', { kind: command.kind, code: failureCodeV1(cause) });
    answer = { outcome: 'failed', html: TELEGRAM_REPLIES_V1.unavailable };
  }
  try {
    await telegramRuntime.bot(config).sendMessage({ chatId: command.chatId, html: answer.html, ...(answer.button ? { button: answer.button } : {}) });
    logger.info('Telegram command', { kind: command.kind, outcome: answer.outcome });
  } catch (cause) {
    logger.warn('Telegram reply failed', { kind: command.kind, outcome: answer.outcome, code: failureCodeV1(cause) });
  }
  res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Connect, read, disconnect — behind the session
// ---------------------------------------------------------------------------

export const telegramLinkRouter = Router();

/** A wallet proven by a real sign-in. The development single user — the zero
 * address, under test or DEV_SINGLE_USER — is not one: a chat must never be
 * joined to a wallet nobody signed for. */
function sessionWalletV1(req: Request, res: Response): string | null {
  const user = tenantUserFromRequest(req);
  const wallet = typeof user?.address === 'string' ? user.address.toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || user?.id !== `eip155:8453:${wallet}` || /^0x0{40}$/.test(wallet)) {
    res.status(401).json({ error: 'authentication_required', code: 'authentication_required' });
    return null;
  }
  return wallet;
}

telegramLinkRouter.get('/link', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const config = telegramRuntime.config();
  if (!config) {
    res.json({ available: false, linked: false });
    return;
  }
  try {
    const chats = await telegramRuntime.links().chatsOf([wallet]);
    res.json({ available: true, linked: (chats.get(wallet)?.length ?? 0) > 0 });
  } catch (cause) {
    logger.warn('Telegram link read failed', { code: failureCodeV1(cause) });
    res.status(503).json({ error: 'telegram_storage_unavailable', code: 'telegram_storage_unavailable' });
  }
});

telegramLinkRouter.post('/link', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const config = telegramRuntime.config();
  if (!config) {
    res.status(404).json({ error: 'telegram_unavailable', code: 'telegram_unavailable' });
    return;
  }
  const allowance = await issueLimiter.consume(`telegram-link:${wallet}`);
  if (!allowance.success) {
    res.status(429).json({ error: 'telegram_link_rate_limited', code: 'telegram_link_rate_limited' });
    return;
  }
  let username: string;
  try {
    username = await botUsernameV1(config);
  } catch (cause) {
    logger.warn('Telegram bot unreachable', { code: failureCodeV1(cause) });
    res.status(503).json({ error: 'telegram_unavailable', code: 'telegram_unavailable' });
    return;
  }
  const now = telegramRuntime.now();
  const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS_V1);
  const { code, hash } = telegramRuntime.newCode();
  try {
    const links = telegramRuntime.links();
    await links.pruneCodes({ before: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
    await links.issueCode({ codeHash: hash, walletAddress: wallet, now, expiresAt });
  } catch (cause) {
    logger.warn('Telegram link code failed', { code: failureCodeV1(cause) });
    res.status(503).json({ error: 'telegram_storage_unavailable', code: 'telegram_storage_unavailable' });
    return;
  }
  // Returned once and stored only as its hash.
  res.status(201).json({ url: telegramStartUrlV1(username, code), expiresAt: expiresAt.toISOString() });
});

telegramLinkRouter.delete('/link', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const config = telegramRuntime.config();
  let chats: string[];
  try {
    chats = await telegramRuntime.links().unlinkWallet(wallet);
  } catch (cause) {
    logger.warn('Telegram unlink failed', { code: failureCodeV1(cause) });
    res.status(503).json({ error: 'telegram_storage_unavailable', code: 'telegram_storage_unavailable' });
    return;
  }
  // The chat is told, so a person who disconnected on the website is not left
  // wondering why the bot went quiet. Best effort: the link is already gone.
  if (config) {
    const bot = telegramRuntime.bot(config);
    for (const chatId of chats) {
      try {
        await bot.sendMessage({ chatId, html: TELEGRAM_REPLIES_V1.disconnectedOnWebsite(wallet) });
      } catch (cause) {
        logger.warn('Telegram unlink notice failed', { code: failureCodeV1(cause) });
      }
    }
  }
  res.json({ available: config !== null, linked: false });
});
