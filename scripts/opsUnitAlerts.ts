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
    case 'exit-code': return exitStatus === null ? 'exited with an error' : `exit code ${exitStatus}`;
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
