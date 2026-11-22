import {
  escapeTelegramHtmlV1,
  openStillAgentBotTokenV1,
  TelegramBotErrorV1,
  type StillAgentBotConfigV1,
  type TelegramBotClientV1,
} from '@mioagent/telegram';
import { stillErrandNextDueV1, stillErrandReminderV1 } from '../lib/still-engine/src/agent.js';
import type { StillAgentRepositoryV1, StillAgentV1, StillErrandV1 } from '@mioagent/route-storage';

import { stillAgentLimitV1, stillAgentPausedV1 } from '../artifacts/api-server/lib/stillAgent.js';

// ---------------------------------------------------------------------------
// Still Agent's errands pass: every five minutes, the errands whose day came.
//
// Each due day is claimed once (still_agent_errand_runs), so two passes never
// remind twice, and the errand moves to its next day before anything is sent.
// The reminder goes from the person's own bot when they started it, else from
// Still's agents bot when a chat is joined, else nowhere but the site, where
// the agent's page shows the review as ready for three days. A failed send
// leaves the day on the site: it is never retried into a second message.
//
// Nothing here buys, reserves or opens an invoice: the link opens Spend on
// the errand's card, and Bitrefill's invoice is opened only when the person
// presses Pay, at that moment's price.
//
// An errand over the free one while no pass runs is paused: its day is
// claimed as 'paused' and nothing is sent. A day missed by more than two days
// (the pass was down) is claimed for the site only: a late reminder for a
// birthday would read as a mistake.
// ---------------------------------------------------------------------------

export const STILL_ERRAND_LATE_MS_V1 = 2 * 24 * 60 * 60 * 1000;

export interface StillAgentErrandsDepsV1 {
  repository: StillAgentRepositoryV1;
  /** Still's agents bot; null when it is not configured, and then reminders stay on the site. */
  config: StillAgentBotConfigV1 | null;
  bot: (token: string) => TelegramBotClientV1;
  now: () => Date;
  log: (line: string) => void;
}

export interface StillAgentErrandsResultV1 {
  due: number;
  claimed: number;
  ownBot: number;
  agentsBot: number;
  siteOnly: number;
  paused: number;
  late: number;
  failed: number;
}

/** The reminder as Telegram HTML, with the link that opens Spend on the errand. */
export function stillErrandMessageV1(agent: StillAgentV1, errand: StillErrandV1, origin: string): { html: string; button: { text: string; url: string } } {
  const words = stillErrandReminderV1({
    language: agent.language, agentName: agent.name, kind: errand.kind, schedule: errand.schedule,
    productName: errand.productName, packageLabel: errand.packageLabel, funding: errand.funding, recipient: errand.recipient,
  });
  return {
    html: `<b>${escapeTelegramHtmlV1(words.title)}</b>\n${words.lines.map(escapeTelegramHtmlV1).join('\n')}`,
    button: { text: words.button, url: `${origin}/spend?errand=${errand.errandId}` },
  };
}

function failureOfV1(cause: unknown): string {
  return cause instanceof TelegramBotErrorV1 ? cause.message : cause instanceof Error ? cause.name : 'error';
}

export async function runStillAgentErrandsV1(deps: StillAgentErrandsDepsV1, options: { dry: boolean; limit?: number }): Promise<StillAgentErrandsResultV1> {
  const result: StillAgentErrandsResultV1 = { due: 0, claimed: 0, ownBot: 0, agentsBot: 0, siteOnly: 0, paused: 0, late: 0, failed: 0 };
  const now = deps.now();
  const due = await deps.repository.dueErrands({ now, limit: options.limit ?? 200 });
  result.due = due.length;
  const pausedOf = new Map<string, Set<string>>();
  for (const { errand, agent } of due) {
    let paused = pausedOf.get(agent.walletAddress);
    if (!paused) {
      const [passes, errands] = await Promise.all([deps.repository.passesOf(agent.walletAddress), deps.repository.errandsOf(agent.walletAddress)]);
      paused = stillAgentPausedV1(errands, stillAgentLimitV1(passes, now));
      pausedOf.set(agent.walletAddress, paused);
    }
    const dueAt = new Date(errand.nextDueAt);
    const late = now.getTime() - dueAt.getTime() > STILL_ERRAND_LATE_MS_V1;
    // The next day after this one, or after now when the pass was down for longer than a period.
    const nextDueAt = stillErrandNextDueV1(errand.schedule, errand.timeZone, late ? now : dueAt);
    const quiet = paused.has(errand.errandId);
    if (options.dry) {
      deps.log(`errand due ${quiet ? 'paused' : late ? 'late' : 'remind'} next=${nextDueAt.toISOString()}`);
      continue;
    }
    const claimed = await deps.repository.claimRun({ errandId: errand.errandId, dueAt, nextDueAt, told: quiet ? 'paused' : 'site', now });
    if (!claimed) continue;
    result.claimed += 1;
    if (quiet) {
      result.paused += 1;
      continue;
    }
    if (late) {
      result.late += 1;
      continue;
    }
    const config = deps.config;
    if (!config) {
      result.siteOnly += 1;
      continue;
    }
    const message = stillErrandMessageV1(agent, errand, config.origin);
    // The person's own bot, once they started it; else the agents bot's chat.
    const ownToken = agent.bot?.chatId && config.key ? await deps.repository.botOf(agent.bot.botId)
      .then((found) => (found ? openStillAgentBotTokenV1(config.key!, found.tokenEnc) : null)) : null;
    const route: { token: string; chatId: string; told: 'own_bot' | 'agents_bot' } | null = ownToken && agent.bot?.chatId
      ? { token: ownToken, chatId: agent.bot.chatId, told: 'own_bot' }
      : agent.telegram ? { token: config.token, chatId: agent.telegram.chatId, told: 'agents_bot' } : null;
    if (!route) {
      result.siteOnly += 1;
      continue;
    }
    try {
      await deps.bot(route.token).sendMessage({ chatId: route.chatId, html: message.html, button: message.button });
      await deps.repository.markRunTold({ errandId: errand.errandId, dueAt, told: route.told, now: deps.now() });
      if (route.told === 'own_bot') result.ownBot += 1;
      else result.agentsBot += 1;
    } catch (cause) {
      result.failed += 1;
      deps.log(`errand reminder not sent via=${route.told} ${failureOfV1(cause)}`);
      // A chat that blocked the agents bot or is gone is let go, as the alerts bot does.
      if (cause instanceof TelegramBotErrorV1 && cause.gone && route.told === 'agents_bot') {
        await deps.repository.unlinkWallet(agent.walletAddress).catch(() => undefined);
      }
    }
  }
  return result;
}
