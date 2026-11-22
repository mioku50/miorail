import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { escapeTelegramHtmlV1 } from './format.js';

// ---------------------------------------------------------------------------
// Still Agent in Telegram (2026-11-22): a second bot, apart from the alerts
// bot, so that nothing it does can cost a person their loan alerts.
//
// The agents bot (`STILL_AGENT_BOT_TOKEN`) joins a chat to a wallet's agent
// with a one-time code, like the alerts bot, and makes each person a bot of
// their own through Telegram's Managed Bots (Bot API 9.6): the person confirms
// it in Telegram, the agents bot is told, and asks Telegram for its token.
// That token is a credential for a bot the person owns, so it is kept sealed
// with `STILL_AGENT_BOT_KEY`, a key that is not in the database, and each such
// bot's webhook secret is derived from the same key and the bot's id.
//
// No bot here sells anything, names a price or links to a payment: Telegram
// takes payment for digital services only in Stars (Bot Developer Terms §6.2).
// ---------------------------------------------------------------------------

export interface StillAgentBotConfigV1 {
  token: string;
  webhookSecret: string;
  origin: string;
  /** The key that seals personal bots' tokens; null while it is not set, and then no personal bot is made. */
  key: Buffer | null;
}

const TOKEN_V1 = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;
const ORIGIN_V1 = /^https:\/\/[a-z0-9.-]+$/;

function unquoteV1(value: string | undefined): string {
  return (value ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

/** Null means the agents bot is off. */
export function stillAgentBotConfigV1(env: NodeJS.ProcessEnv): StillAgentBotConfigV1 | null {
  const token = unquoteV1(env.STILL_AGENT_BOT_TOKEN);
  if (!TOKEN_V1.test(token)) return null;
  const origin = (env.MIORAIL_TELEGRAM_ORIGIN ?? 'https://miorail.xyz').trim().replace(/\/+$/, '');
  if (!ORIGIN_V1.test(origin)) return null;
  const rawKey = unquoteV1(env.STILL_AGENT_BOT_KEY);
  const key = /^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(rawKey) ? Buffer.from(rawKey, rawKey.includes('-') || rawKey.includes('_') ? 'base64url' : 'base64') : null;
  return {
    token,
    webhookSecret: createHmac('sha256', token).update('still-agent-webhook-v1').digest('base64url'),
    origin,
    key: key && key.length === 32 ? key : null,
  };
}

export function stillAgentWebhookUrlV1(config: Pick<StillAgentBotConfigV1, 'origin'>): string {
  return `${config.origin}/api/telegram/agent/webhook`;
}

/** A personal bot's webhook: its own path and its own secret, both from its id. */
export function stillAgentOwnBotWebhookV1(config: Pick<StillAgentBotConfigV1, 'origin' | 'key'>, botId: string): { url: string; secretToken: string } | null {
  if (!config.key || !/^[1-9][0-9]{0,19}$/.test(botId)) return null;
  return {
    url: `${config.origin}/api/telegram/agent/bot/${botId}`,
    secretToken: createHmac('sha256', config.key).update(`still-agent-own-bot-v1:${botId}`).digest('base64url'),
  };
}

/** A personal bot's token, sealed: AES-256-GCM, a fresh nonce each time. */
export function sealStillAgentBotTokenV1(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

/** The token again, or null for anything not sealed by this key. */
export function openStillAgentBotTokenV1(key: Buffer, sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
    const token = Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8');
    return TOKEN_V1.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The link that asks Telegram to make a personal bot managed by the agents bot, its names filled in and editable. */
export function stillAgentNewBotUrlV1(input: { managerUsername: string; agentName: string }): string {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(input.managerUsername)) throw new Error('invalid manager bot username');
  // Telegram's own rules for a bot's @username: Latin letters, digits and underscores, ending in "bot".
  const stem = input.agentName.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'My';
  const username = `${stem}_still_bot`.replace(/^([0-9])/, 'A$1');
  return `https://t.me/newbot/${input.managerUsername}/${username}?name=${encodeURIComponent(`${input.agentName} · Still Agent`)}`;
}

// --- updates ---------------------------------------------------------------

export type StillAgentUpdateV1 =
  | { kind: 'start'; chatId: string; code: string | null }
  | { kind: 'stop'; chatId: string }
  | { kind: 'status'; chatId: string }
  | { kind: 'help'; chatId: string }
  /** Telegram made, or re-tokened, a bot the agents bot manages. */
  | { kind: 'managed_bot'; creatorId: string; botId: string; botUsername: string }
  | { kind: 'ignored' };

const ID_V1 = /^[1-9][0-9]{0,19}$/;
const START_V1 = /^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s+(\S+))?\s*$/;
const COMMAND_V1 = /^\/(stop|status)(?:@[A-Za-z0-9_]{5,32})?\s*$/;
const CODE_V1 = /^[A-Za-z0-9_-]{1,64}$/;

function idOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && ID_V1.test(value)) return value;
  return null;
}

/** What an update to the agents bot, or to a personal bot, asks for. */
export function stillAgentUpdateV1(update: unknown): StillAgentUpdateV1 {
  const body = update as { message?: unknown; managed_bot?: unknown } | null;
  const managed = body?.managed_bot as Record<string, unknown> | undefined;
  if (managed && typeof managed === 'object') {
    // ManagedBotUpdated: the bot and the user who created it.
    const bot = (managed.bot ?? managed.managed_bot) as { id?: unknown; username?: unknown } | undefined;
    const creator = (managed.user ?? managed.from ?? managed.creator) as { id?: unknown } | undefined;
    const botId = idOf(bot?.id), creatorId = idOf(creator?.id);
    const botUsername = typeof bot?.username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(bot.username) ? bot.username : null;
    return botId && creatorId && botUsername ? { kind: 'managed_bot', creatorId, botId, botUsername } : { kind: 'ignored' };
  }
  const message = body?.message as { chat?: { id?: unknown; type?: unknown }; text?: unknown } | undefined;
  if (!message || message.chat?.type !== 'private') return { kind: 'ignored' };
  const chatId = idOf(message.chat.id);
  if (!chatId) return { kind: 'ignored' };
  if (typeof message.text !== 'string') return { kind: 'help', chatId };
  const text = message.text.trim();
  const start = START_V1.exec(text);
  if (start) {
    const code = start[1] ?? null;
    return { kind: 'start', chatId, code: code !== null && CODE_V1.test(code) ? code : code === null ? null : '' };
  }
  const command = COMMAND_V1.exec(text);
  if (command) return { kind: command[1] as 'stop' | 'status', chatId };
  return { kind: 'help', chatId };
}

/** The keys of an update's managed_bot object, for the log when its shape is not the one read: never the values. */
export function stillAgentUpdateShapeV1(update: unknown): string[] {
  const managed = (update as { managed_bot?: unknown } | null)?.managed_bot;
  return managed && typeof managed === 'object' ? Object.keys(managed as object).sort() : [];
}

// --- what the bots say -----------------------------------------------------

const NEVER_SIGN_V1 = 'Still never asks you to sign anything in Telegram, and never for a recovery phrase.';
const NEVER_SIGN_RU_V1 = 'Still никогда не просит подписать что-либо в Telegram и никогда не спрашивает фразу восстановления.';

export const STILL_AGENT_REPLIES_V1 = {
  connected: (names: readonly string[], ru: boolean) => ru
    ? `Готово: ${names.map(escapeTelegramHtmlV1).join(', ')} будет писать сюда в дни ваших поручений. Ссылка ведёт в Still: там вы видите цену и подписываете сами.\n\n${NEVER_SIGN_RU_V1} /stop отключает.`
    : `Done: ${names.map(escapeTelegramHtmlV1).join(', ')} will write here on the days of your errands. The link opens Still, where you see the price and sign yourself.\n\n${NEVER_SIGN_V1} /stop disconnects.`,
  alreadyConnected: (name: string, ru: boolean) => ru
    ? `${escapeTelegramHtmlV1(name)} уже пишет сюда. /status показывает, что подключено.`
    : `${escapeTelegramHtmlV1(name)} already writes here. /status shows what is connected.`,
  expired: 'This link has expired or was already used. Open Still, go to Agent and press Connect Telegram again.',
  howToConnect: `To connect your agent, open Still, go to Agent and press Connect Telegram. ${NEVER_SIGN_V1}`,
  stopped: 'Disconnected. Your agent will not write here any more. /start connects again.',
  nothingToStop: 'Nothing is connected here.',
  status: (names: readonly string[]) => names.length === 0
    ? 'Nothing is connected here yet. Open Still, go to Agent and press Connect Telegram.'
    : `Connected: ${names.map(escapeTelegramHtmlV1).join(', ')}. /stop disconnects.`,
  help: `This bot sends your Still Agent's reminders. /status shows what is connected, /stop disconnects. ${NEVER_SIGN_V1}`,
  ownBotReady: (username: string, ru: boolean) => ru
    ? `Ваш агент готов: @${escapeTelegramHtmlV1(username)}. Откройте его и нажмите Start, и напоминания будут приходить оттуда.`
    : `Your agent is ready: @${escapeTelegramHtmlV1(username)}. Open it and press Start, and reminders will come from there.`,
  ownBotHello: (name: string, ru: boolean) => ru
    ? `Привет, я ${escapeTelegramHtmlV1(name)}, ваш Still Agent. В дни ваших поручений я напишу сюда, что готово к проверке. ${NEVER_SIGN_RU_V1}`
    : `Hi, I'm ${escapeTelegramHtmlV1(name)}, your Still Agent. On the days of your errands I will write here what is ready to review. ${NEVER_SIGN_V1}`,
  ownBotHelp: (name: string, ru: boolean) => ru
    ? `${escapeTelegramHtmlV1(name)} пишет сюда в дни ваших поручений. Поручения меняются в Still, во вкладке Agent. ${NEVER_SIGN_RU_V1}`
    : `${escapeTelegramHtmlV1(name)} writes here on the days of your errands. Errands are changed on Still, under Agent. ${NEVER_SIGN_V1}`,
  unavailable: 'Something went wrong on our side. Please try again in a minute.',
} as const;
