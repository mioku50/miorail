/**
 * One pass of service alerts — what is said and when is in ./opsUnitAlerts.ts.
 *
 * Reads systemd's view of every miorail-* unit, keeps the open failure
 * episodes in $STATE_DIRECTORY/state.json, and writes one message to each chat
 * subscribed in `ops_alert_chats` (scripts/ops_alert_link.ts subscribes one).
 * The chats are also kept in chats.json beside it, renewed by a quiet pass
 * once it is six hours old, so a pass can still speak while the database is
 * the thing that is down. No signer, no chain, no wallet; the bot token is
 * never printed, and no journal line is ever read.
 *
 *   node --import tsx scripts/ops_unit_alerts.ts --dry   plans and prints, sends and writes nothing
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { client, closeDb } from '@mioagent/db';
import { createDatabaseOpsAlertChatRepositoryV1 } from '@mioagent/route-storage';
import { TelegramBotErrorV1, createTelegramBotClientV1, telegramConfigV1 } from '@mioagent/telegram';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import {
  deliveredOpsAlertsV1,
  opsAlertChatCacheStaleV1,
  opsAlertHtmlV1,
  parseOpsAlertStateV1,
  parseSystemctlShowV1,
  planOpsAlertsV1,
  unheardOpsAlertsV1,
  type OpsAlertStateV1,
} from './opsUnitAlerts.js';

const run = promisify(execFile);
const SHOW_V1 = 'Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,StateChangeTimestamp';

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function modifiedAtMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Written whole or not at all; an empty state is no file, which is what
 * the unit's ExecCondition looks for. */
function writeJson(path: string, value: unknown, keep: boolean): void {
  if (!keep) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  reportLoadedEnvFileV1(loadRootEnvFileV1());
  const dir = process.env.STATE_DIRECTORY?.split(':')[0] || '/var/lib/miorail-ops-alerts';
  const statePath = join(dir, 'state.json');
  const chatsPath = join(dir, 'chats.json');
  const state = parseOpsAlertStateV1(readText(statePath));

  const listed = (await run('systemctl', ['list-units', '--all', '--plain', '--no-legend', '--full', 'miorail-*'], { timeout: 20_000 }))
    .stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^miorail-[A-Za-z0-9@._-]+$/.test(name ?? ''));
  // Units with an open episode are asked about by name: one that no longer
  // exists answers LoadState=not-found instead of dropping out of the list.
  const names = [...new Set([...listed, ...state.episodes.map((episode) => episode.unit)])];
  const units = names.length === 0 ? [] : parseSystemctlShowV1(
    (await run('systemctl', ['show', '--timestamp=unix', '-p', SHOW_V1, '--', ...names], { timeout: 20_000 })).stdout,
  );
  const nowMs = Date.now();
  const pass = planOpsAlertsV1({ units, state, nowMs });
  const html = opsAlertHtmlV1(pass, nowMs);
  const summary = {
    event: 'ops_unit_alerts', units: units.length, failed: units.filter((unit) => unit.activeState === 'failed').length,
    open: pass.state.episodes.length, announce: pass.failed.length, remind: pass.stillFailing.length, recovered: pass.recovered.length,
  };
  if (dry) {
    console.log(JSON.stringify({ ...summary, outcome: 'dry' }));
    if (html) console.log(html);
    return;
  }
  mkdirSync(dir, { recursive: true });
  const subscriptions = createDatabaseOpsAlertChatRepositoryV1(client);
  if (html === null) {
    writeJson(statePath, pass.state, pass.state.episodes.length > 0);
    // A quiet pass keeps the copy of the chats current too, so a chat is in it
    // before the first failure, which may be the database's own.
    let chatCache: 'fresh' | 'renewed' | 'unreadable' = 'fresh';
    if (opsAlertChatCacheStaleV1(modifiedAtMs(chatsPath), nowMs)) {
      try {
        writeJson(chatsPath, await subscriptions.chats(), true);
        chatCache = 'renewed';
      } catch {
        chatCache = 'unreadable';
      }
    }
    console.log(JSON.stringify({ ...summary, outcome: 'quiet', chatCache }));
    return;
  }

  const telegram = telegramConfigV1(process.env);
  if (!telegram) {
    writeJson(statePath, pass.state, pass.state.episodes.length > 0);
    console.log(JSON.stringify({ ...summary, outcome: 'telegram_off' }));
    return;
  }
  let chats: string[];
  let chatsFrom: 'database' | 'cache';
  try {
    chats = await subscriptions.chats();
    chatsFrom = 'database';
    writeJson(chatsPath, chats, true);
  } catch {
    const cached = JSON.parse(readText(chatsPath) ?? '[]') as unknown;
    chats = Array.isArray(cached) ? cached.filter((chat): chat is string => typeof chat === 'string' && /^[1-9][0-9]{0,15}$/.test(chat)) : [];
    chatsFrom = 'cache';
  }
  if (chats.length === 0) {
    writeJson(statePath, unheardOpsAlertsV1(pass), unheardOpsAlertsV1(pass).episodes.length > 0);
    console.log(JSON.stringify({ ...summary, outcome: 'no_chat', chatsFrom }));
    return;
  }

  const bot = createTelegramBotClientV1({ token: telegram.token });
  let delivered = 0;
  const failures: string[] = [];
  for (const chatId of chats) {
    try {
      await bot.sendMessage({ chatId, html });
      delivered += 1;
    } catch (cause) {
      failures.push(cause instanceof TelegramBotErrorV1 ? cause.message : 'telegram_error');
      // A chat that blocked the bot or is gone stops being written to.
      if (cause instanceof TelegramBotErrorV1 && cause.gone && chatsFrom === 'database') {
        await subscriptions.unsubscribe(chatId).catch(() => undefined);
      }
    }
  }
  // Not delivered anywhere: the same message is tried again next pass.
  const next: OpsAlertStateV1 = delivered > 0 ? deliveredOpsAlertsV1(pass, nowMs) : pass.state;
  writeJson(statePath, next, next.episodes.length > 0);
  console.log(JSON.stringify({ ...summary, outcome: delivered > 0 ? 'sent' : 'not_delivered', chats: chats.length, delivered, failures, chatsFrom }));
}

main()
  .catch((error) => {
    console.error('service alerts failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
