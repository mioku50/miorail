import { escapeTelegramHtmlV1 } from '@mioagent/telegram';

// ---------------------------------------------------------------------------
// Service alerts: what to say about Miorail's systemd units, and when.
//
// `miorail-rwa-official` failed every hour from 2026-10-07 to 2026-10-09 and
// nobody heard; it was the second time a red unit went unnoticed for days. A
// pass here reads every miorail-* unit's state and keeps one EPISODE per
// failed unit: it is announced when it opens, reminded once a day while the
// unit stays failed, and closed with one message when the unit has settled
// and stayed out of `failed` for a while. Units that fail together (Postgres
// went down, so every worker did) are one message, not one each.
//
// Episodes live in a file, not in the database: the database being down is
// one of the things this has to report. Nothing here reads a journal line,
// so no message can carry what a failing process printed.
// ---------------------------------------------------------------------------

/** One unit as `systemctl show` describes it. Times are ms since the epoch. */
export interface OpsUnitStateV1 {
  unit: string;
  loaded: boolean;
  activeState: string;
  result: string;
  exitStatus: number | null;
  /** When the unit entered its current state. */
  changedAtMs: number | null;
  /** When its main process last exited. */
  lastExitAtMs: number | null;
}

export interface OpsAlertEpisodeV1 {
  unit: string;
  sinceMs: number;
  /** The last pass that saw the unit failed. */
  lastSeenFailedMs: number;
  result: string;
  exitStatus: number | null;
  /** When a message about this episode last reached a chat; null until one has. */
  notifiedMs: number | null;
}

export interface OpsAlertStateV1 {
  episodes: OpsAlertEpisodeV1[];
}

export interface OpsAlertRecoveryV1 {
  episode: OpsAlertEpisodeV1;
  /** healthy: it ran, or runs, cleanly since; cleared: nothing ran, the failed
   * mark was reset by hand; removed: the unit no longer exists. */
  how: 'healthy' | 'cleared' | 'removed';
}

export interface OpsAlertPassV1 {
  /** Every episode after this pass's observations, before any delivery. */
  state: OpsAlertStateV1;
  failed: OpsAlertEpisodeV1[];
  stillFailing: OpsAlertEpisodeV1[];
  recovered: OpsAlertRecoveryV1[];
}

export const OPS_ALERT_REMIND_AFTER_MS_V1 = 24 * 60 * 60 * 1000;
/** How long a unit must stay out of `failed` before it is called recovered,
 * so one that fails on every run is not reported as healing in between. */
export const OPS_ALERT_QUIET_MS_V1 = 10 * 60 * 1000;
/** How old the copy of the subscribed chats may grow before a quiet pass
 * renews it. The copy is what a pass falls back on when the database is the
 * thing that is down, and only a pass that sent something used to write it:
 * the first chat, subscribed on 2026-10-10, was in no copy until a failure
 * reached it. The unit's ExecCondition starts Node at the same age
 * (`-mmin -360` in miorail-ops-alerts.service). */
export const OPS_ALERT_CHAT_CACHE_MAX_AGE_MS_V1 = 6 * 60 * 60 * 1000;

/** Whether the copy of the subscribed chats is missing or old enough to renew. */
export function opsAlertChatCacheStaleV1(modifiedAtMs: number | null, nowMs: number): boolean {
  return modifiedAtMs === null || nowMs - modifiedAtMs >= OPS_ALERT_CHAT_CACHE_MAX_AGE_MS_V1;
}

/** Still deciding: a run in progress is neither a failure nor a recovery. */
const SETTLING_V1 = new Set(['activating', 'deactivating', 'reloading', 'refreshing']);

export function planOpsAlertsV1(input: {
  units: readonly OpsUnitStateV1[];
  state: OpsAlertStateV1;
  nowMs: number;
}): OpsAlertPassV1 {
  const { nowMs } = input;
  const byUnit = new Map(input.units.map((unit) => [unit.unit, unit]));
  const episodes = new Map(input.state.episodes.map((episode) => [episode.unit, { ...episode }]));
  for (const unit of input.units) {
    if (unit.activeState !== 'failed') continue;
    const open = episodes.get(unit.unit);
    if (open) Object.assign(open, { lastSeenFailedMs: nowMs, result: unit.result, exitStatus: unit.exitStatus });
    else {
      episodes.set(unit.unit, {
        unit: unit.unit, sinceMs: unit.changedAtMs ?? nowMs, lastSeenFailedMs: nowMs,
        result: unit.result, exitStatus: unit.exitStatus, notifiedMs: null,
      });
    }
  }
  const pass: OpsAlertPassV1 = { state: { episodes: [...episodes.values()] }, failed: [], stillFailing: [], recovered: [] };
  for (const episode of pass.state.episodes) {
    const unit = byUnit.get(episode.unit);
    if (unit?.activeState === 'failed') {
      if (episode.notifiedMs === null) pass.failed.push(episode);
      else if (nowMs - episode.notifiedMs >= OPS_ALERT_REMIND_AFTER_MS_V1) pass.stillFailing.push(episode);
      continue;
    }
    if (!unit || !unit.loaded) {
      pass.recovered.push({ episode, how: 'removed' });
      continue;
    }
    if (SETTLING_V1.has(unit.activeState) || nowMs - episode.lastSeenFailedMs < OPS_ALERT_QUIET_MS_V1) continue;
    const ranCleanly =
      unit.activeState === 'active' ||
      (unit.result === 'success' && unit.lastExitAtMs !== null && unit.lastExitAtMs > episode.lastSeenFailedMs);
    pass.recovered.push({ episode, how: ranCleanly ? 'healthy' : 'cleared' });
  }
  return pass;
}

/** The episodes once this pass's message reached a chat. */
export function deliveredOpsAlertsV1(pass: OpsAlertPassV1, nowMs: number): OpsAlertStateV1 {
  const closed = new Set(pass.recovered.map((row) => row.episode.unit));
  const told = new Set([...pass.failed, ...pass.stillFailing].map((episode) => episode.unit));
  return {
    episodes: pass.state.episodes
      .filter((episode) => !closed.has(episode.unit))
      .map((episode) => (told.has(episode.unit) ? { ...episode, notifiedMs: nowMs } : episode)),
  };
}

/** The episodes when no chat is subscribed: a recovery nobody can hear is
 * closed, a failure stays unannounced so the next subscriber hears it. */
export function unheardOpsAlertsV1(pass: OpsAlertPassV1): OpsAlertStateV1 {
  const closed = new Set(pass.recovered.map((row) => row.episode.unit));
  return { episodes: pass.state.episodes.filter((episode) => !closed.has(episode.unit)) };
}

const MONTHS_V1 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function whenV1(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${MONTHS_V1[at.getUTCMonth()]} ${at.getUTCDate()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

function forV1(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** What systemd's Result means, in a few words. */
export function opsFailureReasonV1(result: string, exitStatus: number | null): string {
  switch (result) {
    // 75 is how a pass says its provider throttled it out of most of its work (scripts/rwaCashExitPacer.ts).
    case 'exit-code': return exitStatus === null ? 'exited with an error' : exitStatus === 75 ? 'exit code 75: the provider it works through was rate limiting it' : `exit code ${exitStatus}`;
    case 'timeout': return 'timed out';
    case 'signal': return 'killed by a signal';
    case 'core-dump': return 'crashed';
    case 'watchdog': return 'stopped answering its watchdog';
    case 'start-limit-hit': return 'restarted too often and gave up';
    case 'oom-kill': return 'ran out of memory';
    default: return result || 'failed';
  }
}

/** One Telegram message for the whole pass, or null when there is nothing to say. */
export function opsAlertHtmlV1(pass: OpsAlertPassV1, nowMs: number): string | null {
  const sections: string[] = [];
  const unit = (name: string) => `<code>${escapeTelegramHtmlV1(name)}</code>`;
  const reason = (episode: OpsAlertEpisodeV1) => escapeTelegramHtmlV1(opsFailureReasonV1(episode.result, episode.exitStatus));
  if (pass.failed.length > 0) {
    const title = pass.failed.length === 1 ? 'Miorail: a service failed' : `Miorail: ${pass.failed.length} services failed`;
    sections.push([`<b>${title}</b>`, ...pass.failed.map((episode) =>
      `${unit(episode.unit)} — ${reason(episode)}, ${whenV1(episode.sinceMs)}`)].join('\n'));
  }
  if (pass.stillFailing.length > 0) {
    sections.push(['<b>Still failing</b>', ...pass.stillFailing.map((episode) =>
      `${unit(episode.unit)} — ${reason(episode)}, since ${whenV1(episode.sinceMs)} (${forV1(nowMs - episode.sinceMs)})`)].join('\n'));
  }
  if (pass.recovered.length > 0) {
    sections.push(['<b>Back to normal</b>', ...pass.recovered.map(({ episode, how }) => {
      const span = `failed ${whenV1(episode.sinceMs)}, ${forV1(nowMs - episode.sinceMs)} ago`;
      if (how === 'healthy') return `${unit(episode.unit)} runs cleanly again (${span})`;
      if (how === 'cleared') return `${unit(episode.unit)} is no longer marked failed; nothing has run since (${span})`;
      return `${unit(episode.unit)} no longer exists (${span})`;
    })].join('\n'));
  }
  if (sections.length === 0) return null;
  if (pass.failed.length + pass.stillFailing.length > 0) {
    const first = (pass.failed[0] ?? pass.stillFailing[0])!.unit;
    sections.push(`Why: <code>journalctl -u ${escapeTelegramHtmlV1(first)} -n 80</code> on the server.`);
  }
  return sections.join('\n\n');
}

/** `systemctl show --timestamp=unix -p …` for several units: blocks of
 * KEY=VALUE lines, one block per unit, separated by an empty line. */
export function parseSystemctlShowV1(output: string): OpsUnitStateV1[] {
  const units: OpsUnitStateV1[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    const unit = fields.get('Id');
    if (!unit) continue;
    const time = (key: string) => {
      const match = /^@(\d+)$/.exec(fields.get(key) ?? '');
      return match ? Number(match[1]) * 1000 : null;
    };
    const status = fields.get('ExecMainStatus');
    units.push({
      unit,
      loaded: fields.get('LoadState') === 'loaded',
      activeState: fields.get('ActiveState') ?? 'unknown',
      result: fields.get('Result') ?? '',
      exitStatus: status !== undefined && /^\d+$/.test(status) ? Number(status) : null,
      changedAtMs: time('StateChangeTimestamp'),
      lastExitAtMs: time('ExecMainExitTimestamp'),
    });
  }
  return units;
}

/** A state file as read back; anything that is not one starts over empty. */
export function parseOpsAlertStateV1(text: string | null): OpsAlertStateV1 {
  if (text === null) return { episodes: [] };
  try {
    const value = JSON.parse(text) as { episodes?: unknown };
    if (!Array.isArray(value.episodes)) return { episodes: [] };
    const number = (item: unknown) => typeof item === 'number' && Number.isFinite(item);
    return {
      episodes: value.episodes.filter((row): row is OpsAlertEpisodeV1 => {
        const episode = row as Partial<OpsAlertEpisodeV1> | null;
        return !!episode && typeof episode.unit === 'string' && /^miorail-[A-Za-z0-9@._-]+$/.test(episode.unit)
          && number(episode.sinceMs) && number(episode.lastSeenFailedMs) && typeof episode.result === 'string'
          && (episode.exitStatus === null || number(episode.exitStatus))
          && (episode.notifiedMs === null || number(episode.notifiedMs));
      }),
    };
  } catch {
    return { episodes: [] };
  }
}

// ---------------------------------------------------------------------------
// Things that stop working on a known day (audit SPEND-5, 2026-11-10).
//
// Still's client secret at Bitrefill expires on 2027-01-31. Six hours after
// that every catalogue read and every invoice is refused, Spend is off for
// everyone, and no unit fails: the only record of the date was a note. A date
// like that is given in the environment beside the secret it belongs to, and
// the same pass that reports failed units says when it comes within thirty
// days, again at fourteen, seven, three and one, and once it has passed.
// Each of those once. A date moved further away (the secret was renewed)
// starts over quietly.
//
// What was said is kept in its own file, deadlines.json: the unit's
// ExecCondition starts Node every two minutes while state.json exists, and a
// reminder that stands for a month must not do that.
// ---------------------------------------------------------------------------

export interface OpsDeadlineV1 {
  key: string;
  /** What expires, as a message names it. */
  name: string;
  expiresAtMs: number;
  /** What stops working then. */
  after: string;
  /** What the operator does about it. */
  renew: string;
}

export const OPS_DEADLINE_STAGES_DAYS_V1 = [30, 14, 7, 3, 1, 0] as const;

/** The dated things this server's environment names. A date that is absent or unreadable is none. */
export function opsDeadlinesV1(env: NodeJS.ProcessEnv): OpsDeadlineV1[] {
  const deadlines: OpsDeadlineV1[] = [];
  const bitrefill = Date.parse((env.STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT ?? '').trim());
  if (Number.isFinite(bitrefill) && (env.STILL_BITREFILL_CLIENT_SECRET ?? '').trim() !== '') {
    deadlines.push({
      key: 'bitrefill-client-secret', name: 'Still’s client secret at Bitrefill', expiresAtMs: bitrefill,
      after: 'Still Spend can no longer read Bitrefill’s catalogue or open an invoice',
      renew: 'Register the client again at Bitrefill, then set STILL_BITREFILL_CLIENT_ID, STILL_BITREFILL_CLIENT_SECRET and STILL_BITREFILL_CLIENT_SECRET_EXPIRES_AT and restart miorail-api.',
    });
  }
  return deadlines;
}

export interface OpsDeadlineDueV1 { deadline: OpsDeadlineV1; daysLeft: number; stage: number }

/** Which dates are to be said now. `told` is the stage last said for each; `next` is what to keep once this
 * pass's message reached a chat, `kept` what to keep when it reached none. */
export function planOpsDeadlinesV1(input: { deadlines: readonly OpsDeadlineV1[]; told: Readonly<Record<string, number>>; nowMs: number }):
  { due: OpsDeadlineDueV1[]; next: Record<string, number>; kept: Record<string, number> } {
  const due: OpsDeadlineDueV1[] = [], next: Record<string, number> = {}, kept: Record<string, number> = {};
  for (const deadline of input.deadlines) {
    const daysLeft = (deadline.expiresAtMs - input.nowMs) / 86_400_000;
    // Further away than the first stage: nothing is said, and anything said before is forgotten.
    if (daysLeft > OPS_DEADLINE_STAGES_DAYS_V1[0]) continue;
    const stage = [...OPS_DEADLINE_STAGES_DAYS_V1].reverse().find((days) => daysLeft <= days) ?? 0;
    const before = input.told[deadline.key];
    if (before !== undefined) kept[deadline.key] = before;
    if (before === undefined || stage < before) { due.push({ deadline, daysLeft, stage }); next[deadline.key] = stage; }
    else next[deadline.key] = before;
  }
  return { due, next, kept };
}

/** The dates to say, as one section of the pass's message; null when there are none. */
export function opsDeadlineHtmlV1(due: readonly OpsDeadlineDueV1[]): string | null {
  if (due.length === 0) return null;
  const day = (ms: number) => { const at = new Date(ms); return `${MONTHS_V1[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}`; };
  return ['<b>Miorail: a date is coming</b>', ...due.map(({ deadline, daysLeft }) => {
    const when = daysLeft <= 0 ? `expired on ${day(deadline.expiresAtMs)}` : `expires on ${day(deadline.expiresAtMs)}, in ${daysLeft < 1 ? 'less than a day' : `${Math.floor(daysLeft)} ${Math.floor(daysLeft) === 1 ? 'day' : 'days'}`}`;
    return `${escapeTelegramHtmlV1(deadline.name)} ${when}. ${daysLeft <= 0 ? 'Since then' : 'After that'} ${escapeTelegramHtmlV1(deadline.after)}. ${escapeTelegramHtmlV1(deadline.renew)}`;
  })].join('\n');
}

/** deadlines.json as read back; anything that is not one starts over empty. */
export function parseOpsDeadlineStateV1(text: string | null): Record<string, number> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, number] => /^[a-z0-9-]{1,60}$/.test(entry[0]) && typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 366));
  } catch {
    return {};
  }
}
