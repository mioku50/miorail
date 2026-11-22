import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { client } from '@mioagent/db';
import { InMemoryRateLimiter, logger } from '@mioagent/utils';
import { createDatabaseStillAgentRepositoryV1, type StillAgentRepositoryV1, type StillAgentV1 } from '@mioagent/route-storage';
import {
  STILL_AGENT_AVATARS_V1,
  STILL_AGENT_LANGUAGES_V1,
  stillAgentNameV1,
  stillErrandCollateralV1,
  stillErrandKindFitsV1,
  stillErrandNextDueV1,
  stillErrandRecipientV1,
  stillErrandScheduleV1,
  stillTimeZoneV1,
  type StillAgentAvatarV1,
  type StillAgentLanguageV1,
  type StillErrandFundingV1,
  type StillErrandKindV1,
} from '@mioagent/still-engine/agent';
import {
  STILL_AGENT_REPLIES_V1,
  TELEGRAM_LINK_TTL_MS_V1,
  TelegramBotErrorV1,
  createTelegramBotClientV1,
  newTelegramLinkCodeV1,
  openStillAgentBotTokenV1,
  sealStillAgentBotTokenV1,
  stillAgentBotConfigV1,
  stillAgentNewBotUrlV1,
  stillAgentOwnBotWebhookV1,
  stillAgentUpdateShapeV1,
  stillAgentUpdateV1,
  telegramLinkCodeHashV1,
  telegramStartUrlV1,
  type StillAgentBotConfigV1,
  type TelegramBotClientV1,
} from '@mioagent/telegram';

import { sessionWalletV1 } from '../lib/sessionWallet.js';
import { stillEntryGateV1 } from '../lib/stillRegion.js';
import { stillAgentEnabledV1, stillAgentLimitV1, stillAgentPassOfferedV1, stillAgentWirePageV1, stillErrandProductCheckV1 } from '../lib/stillAgent.js';
import { SPEND_ID_V1, SpendReadFailedV1, readSpendProductV1 } from './stillPublic.js';

// ---------------------------------------------------------------------------
// Still Agent over HTTP (2026-11-22), while STILL_AGENT_V1=on.
//
// Behind the session, at /api/still/agent: the session's own agent, its
// errands, and the Telegram chat and bot it writes from. Nothing here moves
// money or opens an invoice: on an errand's day the person opens Spend from
// the reminder and pays there, as on any other day.
//
// Public, at /api/telegram/agent: the webhooks of Still's agents bot and of
// the bots it made for people, each told apart by the secret Telegram echoes.
//
// No wallet, chat id or token is logged.
// ---------------------------------------------------------------------------

export const stillAgentRuntimeV1 = {
  enabled: (): boolean => stillAgentEnabledV1(process.env),
  passOffered: (): boolean => stillAgentPassOfferedV1(process.env),
  repository: (): StillAgentRepositoryV1 => createDatabaseStillAgentRepositoryV1(client as never),
  product: (id: string) => readSpendProductV1(id),
  entryGate: stillEntryGateV1,
  botConfig: (): StillAgentBotConfigV1 | null => stillAgentBotConfigV1(process.env),
  bot: (token: string): TelegramBotClientV1 => createTelegramBotClientV1({ token }),
  now: () => new Date(),
  newId: (): string => randomUUID(),
  newCode: newTelegramLinkCodeV1,
  // A person's pace: thirty writes a minute, and twelve Telegram links an hour, per wallet.
  writeLimiter: new InMemoryRateLimiter({ windowMs: 60_000, max: 30 }),
  linkLimiter: new InMemoryRateLimiter({ windowMs: 60 * 60_000, max: 12 }),
};

function refuse(res: Response, status: number, code: string, detail?: string): void {
  res.status(status).json({ error: code, code, ...(detail ? { detail } : {}) });
}

function failureCodeV1(cause: unknown): string {
  if (cause instanceof TelegramBotErrorV1) return cause.message;
  if (cause instanceof SpendReadFailedV1) return cause.reason;
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : cause instanceof Error ? cause.name : 'error';
}

/** The agents bot's @username, asked once per token per process. */
let managerUsernameOf: { token: string; username: Promise<string> } | null = null;
function managerUsernameV1(config: StillAgentBotConfigV1): Promise<string> {
  if (!managerUsernameOf || managerUsernameOf.token !== config.token) {
    const username = stillAgentRuntimeV1.bot(config.token).getMe().then((me) => me.username);
    managerUsernameOf = { token: config.token, username };
    username.catch(() => {
      if (managerUsernameOf?.username === username) managerUsernameOf = null;
    });
  }
  return managerUsernameOf.username;
}

/** Test seam: forget the remembered @username. */
export function resetStillAgentBotUsernameV1(): void {
  managerUsernameOf = null;
}

async function pageV1(wallet: string) {
  const repository = stillAgentRuntimeV1.repository();
  const now = stillAgentRuntimeV1.now();
  const [agent, errands, passes] = await Promise.all([repository.agentOf(wallet), repository.errandsOf(wallet), repository.passesOf(wallet)]);
  const config = stillAgentRuntimeV1.botConfig();
  return stillAgentWirePageV1({
    agent, errands, passes, now,
    telegramAvailable: config !== null,
    ownBotAvailable: config !== null && config.key !== null,
    passOffered: stillAgentRuntimeV1.passOffered(),
  });
}

function sendPrivate(res: Response, status: number, body: unknown): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// The session's own agent
// ---------------------------------------------------------------------------

export const stillAgentRouter = Router();

stillAgentRouter.use((_req: Request, res: Response, next) => {
  if (!stillAgentRuntimeV1.enabled()) {
    refuse(res, 404, 'agent_off');
    return;
  }
  next();
});

async function writeAllowedV1(res: Response, wallet: string): Promise<boolean> {
  const allowed = await stillAgentRuntimeV1.writeLimiter.consume(`still-agent:${wallet}`);
  if (!allowed.success) refuse(res, 429, 'agent_rate_limited');
  return allowed.success;
}

stillAgentRouter.get('/', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  try {
    sendPrivate(res, 200, await pageV1(wallet));
  } catch (cause) {
    logger.warn('Still Agent read failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_storage_unavailable');
  }
});

stillAgentRouter.put('/', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet || !(await writeAllowedV1(res, wallet))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = stillAgentNameV1(body.name);
  const avatar = (STILL_AGENT_AVATARS_V1 as readonly unknown[]).includes(body.avatar) ? (body.avatar as StillAgentAvatarV1) : null;
  const language = (STILL_AGENT_LANGUAGES_V1 as readonly unknown[]).includes(body.language) ? (body.language as StillAgentLanguageV1) : null;
  const timeZone = stillTimeZoneV1(body.timeZone);
  if (!name || !avatar || !language || !timeZone) {
    refuse(res, 400, 'agent_invalid', 'A name of 1 to 24 letters, digits and spaces, one of the avatars, English or Russian, and your time zone.');
    return;
  }
  try {
    await stillAgentRuntimeV1.repository().saveAgent({ walletAddress: wallet, name, avatar, language, timeZone, now: stillAgentRuntimeV1.now() });
    sendPrivate(res, 200, await pageV1(wallet));
  } catch (cause) {
    logger.warn('Still Agent save failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_storage_unavailable');
  }
});

function fundingOfV1(raw: unknown): StillErrandFundingV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === 'usdc' && Object.keys(value).length === 1) return { kind: 'usdc' };
  const collateral = stillErrandCollateralV1(value.collateral);
  if (value.kind === 'loan' && Object.keys(value).length === 2 && collateral) return { kind: 'loan', collateral };
  return null;
}

stillAgentRouter.post('/errands', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet || !(await writeAllowedV1(res, wallet))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = body.kind === 'subscription' || body.kind === 'gift' ? (body.kind as StillErrandKindV1) : null;
  const schedule = stillErrandScheduleV1(body.schedule);
  const country = typeof body.country === 'string' && /^[A-Z]{2}$/.test(body.country) ? body.country : null;
  const productId = typeof body.productId === 'string' && SPEND_ID_V1.test(body.productId) ? body.productId : null;
  const packageValue = typeof body.packageValue === 'string' && body.packageValue.trim().length >= 1 && body.packageValue.length <= 64 ? body.packageValue : null;
  const funding = fundingOfV1(body.funding);
  const recipient = body.recipient === undefined || body.recipient === null || body.recipient === '' ? null : stillErrandRecipientV1(body.recipient);
  const recipientBad = body.recipient !== undefined && body.recipient !== null && body.recipient !== '' && recipient === null;
  if (!kind || !schedule || !stillErrandKindFitsV1(kind, schedule) || !country || !productId || !packageValue || !funding || recipientBad
    || (kind === 'subscription' && recipient !== null)) {
    refuse(res, 400, 'errand_invalid');
    return;
  }
  // An errand plans a purchase, or a loan for one: not offered in the United States or to US persons.
  const gate = await stillAgentRuntimeV1.entryGate(req, { kind: funding.kind === 'loan' ? 'loan' : 'purchase', confirmation: false });
  if (!gate.ok) {
    refuse(res, 403, gate.refusal, gate.detail);
    return;
  }
  try {
    const repository = stillAgentRuntimeV1.repository();
    const agent = await repository.agentOf(wallet);
    if (!agent) {
      refuse(res, 409, 'agent_required');
      return;
    }
    let product;
    try {
      product = (await stillAgentRuntimeV1.product(productId)).product;
    } catch (cause) {
      if (cause instanceof SpendReadFailedV1 && cause.reason === 'bitrefill_product_not_found') {
        refuse(res, 404, 'errand_product_unavailable');
        return;
      }
      refuse(res, 503, 'bitrefill_unavailable');
      return;
    }
    const checked = stillErrandProductCheckV1(product, packageValue);
    if (!checked.ok) {
      refuse(res, 409, checked.refusal);
      return;
    }
    const now = stillAgentRuntimeV1.now();
    const limit = stillAgentLimitV1(await repository.passesOf(wallet), now);
    const added = await repository.addErrand({
      walletAddress: wallet, errandId: stillAgentRuntimeV1.newId(), kind, schedule, timeZone: agent.timeZone, country,
      productId, productName: checked.productName, packageValue, packageLabel: checked.packageLabel, funding, recipient,
      nextDueAt: stillErrandNextDueV1(schedule, agent.timeZone, now), now, limit,
    });
    if (added === 'no_agent') {
      refuse(res, 409, 'agent_required');
      return;
    }
    if (added === 'limit') {
      refuse(res, 409, 'errand_limit');
      return;
    }
    sendPrivate(res, 201, await pageV1(wallet));
  } catch (cause) {
    logger.warn('Still Agent errand failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_storage_unavailable');
  }
});

stillAgentRouter.delete('/errands/:errandId', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet || !(await writeAllowedV1(res, wallet))) return;
  const errandId = String(req.params.errandId ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(errandId)) {
    refuse(res, 404, 'errand_not_found');
    return;
  }
  try {
    const removed = await stillAgentRuntimeV1.repository().removeErrand({ walletAddress: wallet, errandId, now: stillAgentRuntimeV1.now() });
    if (!removed) {
      refuse(res, 404, 'errand_not_found');
      return;
    }
    sendPrivate(res, 200, await pageV1(wallet));
  } catch (cause) {
    logger.warn('Still Agent errand removal failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_storage_unavailable');
  }
});

/** A one-time link that joins a Telegram chat to the session's agent. */
stillAgentRouter.post('/telegram', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet) return;
  const config = stillAgentRuntimeV1.botConfig();
  if (!config) {
    refuse(res, 404, 'agent_telegram_unavailable');
    return;
  }
  const allowed = await stillAgentRuntimeV1.linkLimiter.consume(`still-agent-link:${wallet}`);
  if (!allowed.success) {
    refuse(res, 429, 'agent_rate_limited');
    return;
  }
  try {
    const repository = stillAgentRuntimeV1.repository();
    if (!(await repository.agentOf(wallet))) {
      refuse(res, 409, 'agent_required');
      return;
    }
    const username = await managerUsernameV1(config);
    const now = stillAgentRuntimeV1.now();
    const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS_V1);
    const { code, hash } = stillAgentRuntimeV1.newCode();
    await repository.pruneLinkCodes({ before: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
    await repository.issueLinkCode({ codeHash: hash, walletAddress: wallet, now, expiresAt });
    // Returned once and stored only as its hash.
    sendPrivate(res, 201, { url: telegramStartUrlV1(username, code), expiresAt: expiresAt.toISOString() });
  } catch (cause) {
    logger.warn('Still Agent link failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_telegram_unavailable');
  }
});

stillAgentRouter.delete('/telegram', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet || !(await writeAllowedV1(res, wallet))) return;
  try {
    const chatId = await stillAgentRuntimeV1.repository().unlinkWallet(wallet);
    const config = stillAgentRuntimeV1.botConfig();
    // The chat is told, best effort: the link is already gone.
    if (chatId && config) {
      await stillAgentRuntimeV1.bot(config.token).sendMessage({ chatId, html: STILL_AGENT_REPLIES_V1.stopped }).catch((cause: unknown) => {
        logger.warn('Still Agent unlink notice failed', { code: failureCodeV1(cause) });
      });
    }
    sendPrivate(res, 200, await pageV1(wallet));
  } catch (cause) {
    logger.warn('Still Agent unlink failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_storage_unavailable');
  }
});

/** The link that asks Telegram to make the person a bot of their own, managed by the agents bot. */
stillAgentRouter.post('/bot', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet || !(await writeAllowedV1(res, wallet))) return;
  const config = stillAgentRuntimeV1.botConfig();
  if (!config?.key) {
    refuse(res, 404, 'agent_own_bot_unavailable');
    return;
  }
  try {
    const repository = stillAgentRuntimeV1.repository();
    const agent = await repository.agentOf(wallet);
    if (!agent) {
      refuse(res, 409, 'agent_required');
      return;
    }
    if (agent.bot) {
      refuse(res, 409, 'agent_own_bot_exists');
      return;
    }
    // Telegram tells the agents bot who made the new bot: the chat joined first is how it is found.
    if (!(await repository.requestBot({ walletAddress: wallet, now: stillAgentRuntimeV1.now() }))) {
      refuse(res, 409, 'agent_telegram_required');
      return;
    }
    sendPrivate(res, 201, { url: stillAgentNewBotUrlV1({ managerUsername: await managerUsernameV1(config), agentName: agent.name }) });
  } catch (cause) {
    logger.warn('Still Agent bot request failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_telegram_unavailable');
  }
});

stillAgentRouter.delete('/bot', async (req: Request, res: Response) => {
  const wallet = sessionWalletV1(req, res);
  if (!wallet || !(await writeAllowedV1(res, wallet))) return;
  try {
    const detached = await stillAgentRuntimeV1.repository().detachBot(wallet);
    const config = stillAgentRuntimeV1.botConfig();
    // The bot stays the person's in Telegram; Still only stops answering for it.
    const token = detached && config?.key ? openStillAgentBotTokenV1(config.key, detached.tokenEnc) : null;
    if (token) {
      await stillAgentRuntimeV1.bot(token).deleteWebhook().catch((cause: unknown) => {
        logger.warn('Still Agent bot webhook removal failed', { code: failureCodeV1(cause) });
      });
    }
    sendPrivate(res, 200, await pageV1(wallet));
  } catch (cause) {
    logger.warn('Still Agent bot detach failed', { code: failureCodeV1(cause) });
    refuse(res, 503, 'agent_storage_unavailable');
  }
});

// ---------------------------------------------------------------------------
// The webhooks
// ---------------------------------------------------------------------------

export const stillAgentTelegramRouter = Router();

function secretMatchesV1(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type ManagerReplyV1 = { outcome: string; chatId: string; html: string; button?: { text: string; url: string } } | { outcome: string; chatId: null };

async function managerAnswerV1(update: unknown, config: StillAgentBotConfigV1, repository: StillAgentRepositoryV1): Promise<ManagerReplyV1> {
  const now = stillAgentRuntimeV1.now();
  const command = stillAgentUpdateV1(update);
  switch (command.kind) {
    case 'ignored': {
      const shape = stillAgentUpdateShapeV1(update);
      // A managed_bot update this code could not read: its keys, never its values.
      if (shape.length > 0) logger.warn('Still Agent managed bot update unread', { keys: shape.join(',') });
      return { outcome: 'ignored', chatId: null };
    }
    case 'managed_bot': {
      if (!config.key) return { outcome: 'own_bot_no_key', chatId: null };
      const manager = stillAgentRuntimeV1.bot(config.token);
      const token = await manager.getManagedBotToken(command.botId);
      const tokenEnc = sealStillAgentBotTokenV1(config.key, token);
      const known = await repository.botOf(command.botId);
      let agent: StillAgentV1 | null = known?.agent ?? null;
      if (known) {
        // A new token for a bot already ours: keep it, and point the bot back here.
        await repository.setBotToken({ botId: command.botId, tokenEnc });
      } else {
        agent = await repository.claimBot({ chatId: command.creatorId, botId: command.botId, username: command.botUsername, tokenEnc, now });
        if (!agent) return { outcome: 'own_bot_unclaimed', chatId: null };
      }
      const hook = stillAgentOwnBotWebhookV1(config, command.botId)!;
      await stillAgentRuntimeV1.bot(token).setWebhook({ url: hook.url, secretToken: hook.secretToken });
      if (known) return { outcome: 'own_bot_retokened', chatId: null };
      return {
        outcome: 'own_bot_made', chatId: command.creatorId, html: STILL_AGENT_REPLIES_V1.ownBotReady(command.botUsername, agent!.language === 'ru'),
        button: { text: `Open @${command.botUsername}`, url: `https://t.me/${command.botUsername}` },
      };
    }
    case 'start': {
      if (command.code === null) {
        const agents = await repository.agentsOfChat(command.chatId);
        return agents.length > 0
          ? { outcome: 'status', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.status(agents.map((agent) => agent.name)) }
          : { outcome: 'how_to_connect', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.howToConnect, button: { text: 'Open Still', url: `${config.origin}/agent` } };
      }
      const codeHash = telegramLinkCodeHashV1(command.code);
      const redeemed = codeHash ? await repository.redeemLinkCode({ codeHash, chatId: command.chatId, now }) : null;
      if (!redeemed) return { outcome: 'code_refused', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.expired };
      const agent = await repository.agentOf(redeemed.walletAddress);
      const ru = agent?.language === 'ru';
      if (!redeemed.linkedNow) return { outcome: 'already_linked', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.alreadyConnected(agent?.name ?? 'Your agent', ru) };
      return {
        outcome: 'linked', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.connected([agent?.name ?? 'Your agent'], ru),
        button: { text: ru ? 'Открыть Still' : 'Open Still', url: `${config.origin}/agent` },
      };
    }
    case 'stop': {
      const removed = await repository.unlinkChat(command.chatId);
      return removed.length > 0
        ? { outcome: 'stopped', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.stopped }
        : { outcome: 'nothing_to_stop', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.nothingToStop };
    }
    case 'status':
      return { outcome: 'status', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.status((await repository.agentsOfChat(command.chatId)).map((agent) => agent.name)) };
    case 'help':
      return { outcome: 'help', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.help };
  }
}

stillAgentTelegramRouter.post('/agent/webhook', async (req: Request, res: Response) => {
  const config = stillAgentRuntimeV1.enabled() ? stillAgentRuntimeV1.botConfig() : null;
  if (!config) {
    refuse(res, 404, 'agent_telegram_unavailable');
    return;
  }
  if (!secretMatchesV1(req.get('x-telegram-bot-api-secret-token') ?? '', config.webhookSecret)) {
    refuse(res, 401, 'telegram_webhook_refused');
    return;
  }
  let answer: ManagerReplyV1;
  try {
    answer = await managerAnswerV1(req.body, config, stillAgentRuntimeV1.repository());
  } catch (cause) {
    logger.warn('Still Agent update failed', { code: failureCodeV1(cause) });
    const command = stillAgentUpdateV1(req.body);
    answer = 'chatId' in command
      ? { outcome: 'failed', chatId: command.chatId, html: STILL_AGENT_REPLIES_V1.unavailable }
      : { outcome: 'failed', chatId: null };
  }
  if (answer.chatId !== null && 'html' in answer) {
    try {
      await stillAgentRuntimeV1.bot(config.token).sendMessage({ chatId: answer.chatId, html: answer.html, ...(answer.button ? { button: answer.button } : {}) });
    } catch (cause) {
      logger.warn('Still Agent reply failed', { outcome: answer.outcome, code: failureCodeV1(cause) });
    }
  }
  logger.info('Still Agent update', { outcome: answer.outcome });
  // Always 200 once the secret matched: a retried /start would find its code spent.
  res.status(200).json({ ok: true });
});

/** A person's own bot: it answers its owner only, and says who it is. Reminders go out from the errands pass. */
stillAgentTelegramRouter.post('/agent/bot/:botId', async (req: Request, res: Response) => {
  const config = stillAgentRuntimeV1.enabled() ? stillAgentRuntimeV1.botConfig() : null;
  const botId = String(req.params.botId ?? '');
  const hook = config ? stillAgentOwnBotWebhookV1(config, botId) : null;
  if (!config?.key || !hook) {
    refuse(res, 404, 'agent_telegram_unavailable');
    return;
  }
  if (!secretMatchesV1(req.get('x-telegram-bot-api-secret-token') ?? '', hook.secretToken)) {
    refuse(res, 401, 'telegram_webhook_refused');
    return;
  }
  let outcome = 'ignored';
  try {
    const repository = stillAgentRuntimeV1.repository();
    const found = await repository.botOf(botId);
    const command = stillAgentUpdateV1(req.body);
    const owner = found?.agent.bot?.chatId ?? found?.agent.telegram?.chatId ?? null;
    if (found && 'chatId' in command && command.chatId === owner) {
      const token = openStillAgentBotTokenV1(config.key, found.tokenEnc);
      if (token) {
        const ru = found.agent.language === 'ru';
        if (command.kind === 'start') {
          await repository.setBotChat({ botId, chatId: command.chatId });
          outcome = 'own_bot_started';
        } else {
          outcome = 'own_bot_help';
        }
        await stillAgentRuntimeV1.bot(token).sendMessage({
          chatId: command.chatId,
          html: command.kind === 'start' ? STILL_AGENT_REPLIES_V1.ownBotHello(found.agent.name, ru) : STILL_AGENT_REPLIES_V1.ownBotHelp(found.agent.name, ru),
          button: { text: ru ? 'Поручения в Still' : 'Errands on Still', url: `${config.origin}/agent` },
        });
      }
    }
  } catch (cause) {
    logger.warn('Still Agent own bot update failed', { code: failureCodeV1(cause) });
    outcome = 'failed';
  }
  logger.info('Still Agent own bot update', { outcome });
  res.status(200).json({ ok: true });
});
