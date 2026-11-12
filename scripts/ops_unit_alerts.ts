/**
 * One pass of service alerts — what is said and when is in ./opsUnitAlerts.ts.
 *
 * Reads systemd's view of every miorail-* unit and of the system units
 * Miorail stops without (PostgreSQL, nginx, certbot), asks the API for
 * /health, keeps the open episodes in $STATE_DIRECTORY/state.json, and writes
 * one message to each chat subscribed in `ops_alert_chats`
 * (scripts/ops_alert_link.ts subscribes one). A pass runs every two minutes
 * whether or not anything failed: a service that restarts in a loop, or one
 * that is stopped, never shows as failed (audit OPS-5).
 * The chats are also kept in chats.json beside it, renewed by a quiet pass
 * once it is six hours old, so a pass can still speak while the database is
 * the thing that is down. The same message carries a date that is coming
 * (a secret that expires) and the disk once it is 80% full; what was said of
 * those is kept in deadlines.json; the certificates the server presents for
 * its public hosts are dates of the same kind. The automatic-restart counts
 * last seen are kept in watch.json. When OPS_ALERT_HEARTBEAT_URL is set, every
 * pass that got this far asks for it once, so a monitor outside this server
 * can say when the passes themselves stop. No signer, no chain, no wallet; the
 * bot token is never printed, and no journal line is ever read.
 *
 *   node --import tsx scripts/ops_unit_alerts.ts --dry   plans and prints, sends and writes nothing
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';

import { client, closeDb } from '@mioagent/db';
import { createDatabaseOpsAlertChatRepositoryV1 } from '@mioagent/route-storage';
import { TelegramBotErrorV1, createTelegramBotClientV1, telegramConfigV1 } from '@mioagent/telegram';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';
import {
  OPS_DISK_STATE_KEY_V1,
  OPS_SYSTEM_UNITS_V1,
  deliveredOpsAlertsV1,
  opsAlertChatCacheStaleV1,
  opsAlertHtmlV1,
  opsCheckOfV1,
  opsDeadlineHtmlV1,
  opsDeadlinesV1,
  opsDiskHtmlV1,
  opsDiskReadingV1,
  opsHealthIsAskedV1,
  opsTlsDeadlineV1,
  opsTlsHostsV1,
  opsWatchV1,
  parseOpsAlertStateV1,
  parseOpsDeadlineStateV1,
  parseOpsRestartsSeenV1,
  parseSystemctlShowV1,
  planOpsAlertsV1,
  planOpsDeadlinesV1,
  planOpsDiskV1,
  unheardOpsAlertsV1,
  type OpsAlertStateV1,
  type OpsDeadlineV1,
} from './opsUnitAlerts.js';

const run = promisify(execFile);
const SHOW_V1 = 'Id,LoadState,ActiveState,Result,ExecMainStatus,ExecMainExitTimestamp,StateChangeTimestamp,NRestarts';

/** GET /health on the API's own port, asked twice before it is called silent: one slow answer is not an outage. */
async function readHealth(port: string): Promise<{ ok: boolean; detail: string }> {
  let detail = 'no answer';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200) return { ok: true, detail: 'HTTP 200' };
      detail = `HTTP ${response.status}`;
    } catch {
      detail = 'no answer in 5 s';
    }
  }
  return { ok: false, detail };
}

/** When the certificate this server presents for a host ends; null when it presents none for it. */
function readCertificateEnd(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    // Asked of this server itself: it is its own certificate that is being read, not the name's DNS.
    const socket = tlsConnect({ host: '127.0.0.1', port: 443, servername: host, rejectUnauthorized: false, timeout: 5_000 });
    const done = (value: number | null): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const end = Date.parse(certificate?.valid_to ?? '');
      // The default site's certificate, presented for a name this server does not serve, is not that name's.
      done(certificate && Number.isFinite(end) && checkServerIdentity(host, certificate) === undefined ? end : null);
    });
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}

/** Asks the monitor outside this server that a pass has run. Its answer changes nothing here. */
async function beat(url: string | undefined): Promise<'off' | 'sent' | 'failed'> {
  const target = (url ?? '').trim();
  if (!/^https:\/\//.test(target)) return 'off';
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(5_000) });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The filesystem's own counts; null when it cannot be asked. */
function readDisk(path: string): { bsize: number; blocks: number; bfree: number; bavail: number } | null {
  try {
    const stat = statfsSync(path);
    return { bsize: stat.bsize, blocks: stat.blocks, bfree: stat.bfree, bavail: stat.bavail };
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

/** Written whole or not at all; an empty state is no file. */
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
  // An episode of a check is asked about through the unit it belongs to.
  const names = [...new Set([...listed, ...OPS_SYSTEM_UNITS_V1, ...state.episodes.map((episode) => opsCheckOfV1(episode.unit).unit)])];
  const read = parseSystemctlShowV1(
    (await run('systemctl', ['show', '--timestamp=unix', '-p', SHOW_V1, '--', ...names], { timeout: 20_000 })).stdout,
  );
  const nowMs = Date.now();
  // What `failed` does not show: a unit that is stopped, one systemd keeps starting again, an API
  // that runs and does not answer, a backup that stopped being taken.
  const watchPath = join(dir, 'watch.json');
  const port = (process.env.PORT ?? '').trim() || '8080';
  const health = opsHealthIsAskedV1(read, nowMs) ? await readHealth(port) : null;
  const watch = opsWatchV1({
    units: read, nowMs,
    restartsSeen: parseOpsRestartsSeenV1(readText(watchPath)),
    health,
    open: state.episodes.map((episode) => episode.unit),
  });
  const units = watch.units;
  const pass = planOpsAlertsV1({ units, state, nowMs });
  // Dates that are coming (a secret that expires, a certificate that ends) are said by the same pass, in
  // the same message; what was said of them lives in its own file.
  const deadlinesPath = join(dir, 'deadlines.json');
  const told = parseOpsDeadlineStateV1(readText(deadlinesPath));
  const certificates: OpsDeadlineV1[] = [];
  for (const host of opsTlsHostsV1(process.env)) {
    const end = await readCertificateEnd(host);
    if (end !== null) certificates.push(opsTlsDeadlineV1(host, end));
  }
  const deadlines = planOpsDeadlinesV1({ deadlines: [...opsDeadlinesV1(process.env), ...certificates], told, nowMs });
  // How full the disk is, read where the database lives. The line last said of it is kept in the same file.
  const disk = planOpsDiskV1({ reading: opsDiskReadingV1(readDisk('/')), told: told[OPS_DISK_STATE_KEY_V1] ?? 0 });
  const keepDeadlines = (delivered: boolean): void => {
    const value = { ...(delivered ? deadlines.next : deadlines.kept) };
    const line = delivered ? disk.next : disk.kept;
    if (line > 0) value[OPS_DISK_STATE_KEY_V1] = line;
    writeJson(deadlinesPath, value, Object.keys(value).length > 0);
  };
  const html = [opsAlertHtmlV1(pass, nowMs), opsDeadlineHtmlV1(deadlines.due), opsDiskHtmlV1(disk)].filter((section): section is string => section !== null).join('\n\n') || null;
  const summary = {
    event: 'ops_unit_alerts', units: units.length, failed: units.filter((unit) => unit.activeState === 'failed').length,
    open: pass.state.episodes.length, announce: pass.failed.length, remind: pass.stillFailing.length, recovered: pass.recovered.length,
    health: health === null ? 'not_asked' : health.ok ? 'ok' : 'silent',
    dates: deadlines.due.length, certificates: certificates.length,
    certificateDays: certificates.length === 0 ? null : Math.floor((Math.min(...certificates.map((row) => row.expiresAtMs)) - nowMs) / 86_400_000),
    diskPercent: disk.reading ? Math.floor(disk.reading.usedPercent) : null, disk: disk.say,
  };
  if (dry) {
    console.log(JSON.stringify({ ...summary, outcome: 'dry' }));
    if (html) console.log(html);
    return;
  }
  mkdirSync(dir, { recursive: true });
  // The counts are what was seen, whatever is said of them: the episodes hold what is still to say.
  writeJson(watchPath, watch.restartsSeen, Object.keys(watch.restartsSeen).length > 0);
  const heartbeat = await beat(process.env.OPS_ALERT_HEARTBEAT_URL);
  Object.assign(summary, { heartbeat });
  const subscriptions = createDatabaseOpsAlertChatRepositoryV1(client);
  if (html === null) {
    writeJson(statePath, pass.state, pass.state.episodes.length > 0);
    keepDeadlines(false);
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
    keepDeadlines(false);
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
    keepDeadlines(false);
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
  keepDeadlines(delivered > 0);
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
