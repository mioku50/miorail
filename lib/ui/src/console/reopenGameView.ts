import {
  reopenShareLineV1,
  type ReopenDirectionV1,
  type ReopenGameResponseV1,
} from '@mioagent/rwa-market-reality/reopen-game';
import { etWeekdayV1 } from '@mioagent/rwa-market-reality/weekend-market';

import { giftShareLinksV1 } from './giftView';
import { countdownV1, etLabelV1, signedPercentV1 } from './weekendMarketView';

export { countdownV1 };

// ---------------------------------------------------------------------------
// Call the reopen, in words.
//
// One question per stock, said the same way in every state: will it reopen
// above or below the close. The close is named by its day: Friday's on most
// weekends, Thursday's before a holiday Friday. Base is an opponent with a
// record, never an oracle: its call is its own price at the lock, and its
// record is the rounds actually played. Up and down carry no colour; only right
// and wrong do, once a round is settled.
//
// After a pick, one way out of the game: a piece of NVIDIA from $1, the same
// stock whatever was picked. Nothing in the game says buy what you called.
//
// One clock on the page: the countdown to the next moment. The lede names
// that moment by its time and never says "in 2 h" beside it, because two
// clocks that round differently read as one clock that is wrong.
// ---------------------------------------------------------------------------

export interface ReopenGameRowViewV1 {
  symbol: string;
  name: string;
  close: string;
  /** While picks are open: the price on Base now and its move from the close. */
  baseNow: string | null;
  /** Once picks closed: Base's call, at its price at the lock. */
  baseCall: string | null;
  pick: ReopenDirectionV1 | null;
  /** After the lock: how the players split. */
  crowd: string | null;
  /** Once settled: where it reopened and which way. */
  result: string | null;
  /** Once settled: the reader's square. */
  mark: '🟩' | '🟥' | '⬜' | null;
  /** Coinbase's icon for the token, when the list has one. */
  icon: string | null;
}

/** One of the round's three moments: passed, next, or after that. */
export interface ReopenGameStepViewV1 {
  key: 'open' | 'lock' | 'reopen';
  label: string;
  at: string;
  state: 'done' | 'now' | 'next';
}

/** A number set large, with what it counts. */
export interface ReopenGameTileViewV1 {
  key: string;
  label: string;
  value: string;
  detail: string | null;
  /** How full the bar under it is, 0 to 1; null draws none. */
  progress?: number | null;
}

export interface ReopenLeaderboardViewV1 {
  title: string;
  note: string;
  rows: { key: string; rank: string; medal: string | null; name: string; score: string; rounds: string; you: boolean }[];
  /** The reader's place when it is below the rows shown. */
  me: string | null;
}

/** The stock the game points at once a reader has played: the same one for
 * everybody, whatever they called. */
export const REOPEN_CTA_SYMBOL_V1 = 'NVDA';

export interface ReopenGameViewV1 {
  state: 'upcoming' | 'open' | 'locked' | 'settled';
  roundId: string | null;
  title: string;
  badge: string;
  lede: string;
  /** The day of the close every call is about: "Friday", or "Thursday" before
   * a holiday Friday. Null before a round is shown. */
  closeDay: { long: string; short: string } | null;
  rows: ReopenGameRowViewV1[];
  /** The reader's standing, or how to keep it. */
  standing: string | null;
  /** Shown with a sign-in button: a device keeps picks, a wallet keeps a streak. */
  keepWithWallet: boolean;
  rules: string;
  share: { x: string; farcaster: string } | null;
  error: string | null;
  /** Everybody who played a settled round; null before the first one. */
  leaderboard: ReopenLeaderboardViewV1 | null;
  /** Once the reader has picked: the way to the stock itself, unrelated to
   * any call. */
  cta: { label: string; symbol: string; href: string } | null;
  /** The next moment that matters, counted down on screen: the opening, the
   * lock, the reopen, or the next round. `left` is the count when the view
   * was built; the screen recounts it from `until`. */
  clock: { until: string; left: string; label: string; at: string } | null;
  /** The round's three moments, from the opening to the reopen. */
  steps: ReopenGameStepViewV1[];
  /** The reader's calls, Base's record, players, or the score. */
  tiles: ReopenGameTileViewV1[];
  /** Once settled with a pick: the reader against Base. Only this and right or
   * wrong wear colour. */
  verdict: { text: string; tone: 'won' | 'lost' | 'level' } | null;
}

function clockV1(until: string, label: string, now: Date): ReopenGameViewV1['clock'] {
  const left = countdownV1(until, now);
  return left ? { until, left, label, at: etLabelV1(until) } : null;
}

/** The opening and the lock are done once passed; the reopen only once the
 * round settled, since the prints that settle it land after the bell. */
function stepsV1(
  moments: { opensAt: string; locksAt: string; expectedReopenAt: string },
  now: Date,
  settled: boolean,
): ReopenGameStepViewV1[] {
  const list = [
    { key: 'open', label: 'Picks open', at: moments.opensAt },
    { key: 'lock', label: 'Picks close, Base calls', at: moments.locksAt },
    { key: 'reopen', label: 'Wall Street reopens', at: moments.expectedReopenAt },
  ] as const;
  let next = false;
  return list.map((step) => {
    const done = settled || (step.key !== 'reopen' && Date.parse(step.at) <= now.getTime());
    const state = done ? 'done' : next ? 'next' : 'now';
    if (!done) next = true;
    return { key: step.key, label: step.label, at: etLabelV1(step.at), state };
  });
}

const MEDAL_V1: Readonly<Record<number, string>> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** The table, in words. A wallet is named only by a Basename it set for
 * itself; everybody else, signed in or not, is a number. */
export function reopenLeaderboardViewV1(
  board: ReopenGameResponseV1['leaderboard'],
): ReopenLeaderboardViewV1 | null {
  if (!board || board.rows.length === 0) return null;
  const shownYou = board.rows.some((row) => row.you);
  return {
    title: 'Leaderboard',
    note: `After ${plural(board.rounds, 'round', 'rounds')} · ${plural(board.players, 'player', 'players')}. Most right first. A wallet with a Basename is listed by it; everyone else by player number.`,
    rows: board.rows.map((row, index) => ({
      key: `${row.rank}:${index}`,
      rank: `#${row.rank}`,
      medal: MEDAL_V1[row.rank] ?? null,
      name: row.you ? `${row.name} · you` : row.name,
      score: `${row.correct}/${row.of}`,
      rounds: String(row.played),
      you: row.you,
    })),
    me:
      board.me && !shownYou
        ? `You: #${board.me.rank} of ${board.players} · ${board.me.correct}/${board.me.of} right over ${plural(board.me.played, 'round', 'rounds')}.`
        : null,
  };
}

const RULES_V1 =
  "The close is the Chainlink price at the last bell before the weekend: Friday's at 16:00 ET, Thursday's before a holiday Friday, 13:00 ET on a short day. Base's call is its own price at the lock: the median of Miorail's $100 quotes over the six hours before 17:00 ET Sunday, above or below the close. The result is the first Chainlink price Miorail records after Wall Street reopens at 20:00 ET; a stock that reopens exactly at the close, or does not print, counts for nobody. Picks close three hours early because futures open at 18:00 ET and show the way. No prizes: tokenized stocks are not offered to US persons, and this is played for the record.";

const ARROW_V1: Readonly<Record<ReopenDirectionV1, string>> = { up: '▲', down: '▼' };
const WORD_V1: Readonly<Record<ReopenDirectionV1, string>> = { up: 'above', down: 'below' };

function usdV1(value: string): string {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A quiet period opens at 20:00 ET on the day of its close. */
function closeDayV1(opensAt: string): { long: string; short: string } {
  return { long: etWeekdayV1(opensAt, 'long'), short: etWeekdayV1(opensAt, 'short') };
}

const CTA_V1 = {
  label: 'A piece of NVIDIA, from $1',
  symbol: REOPEN_CTA_SYMBOL_V1,
  href: `/stocks/${REOPEN_CTA_SYMBOL_V1.toLowerCase()}`,
} as const;

export function reopenGameViewV1(
  response: ReopenGameResponseV1 | null | undefined,
  input: {
    now: Date;
    origin: string;
    /** Picks sent but not yet answered, shown as already made. */
    pending?: Readonly<Record<string, ReopenDirectionV1>> | null;
    failed?: string | null;
    /** Token address (lowercase) to its icon path, from the list's prices. */
    icons?: ReadonlyMap<string, string> | null;
  },
): ReopenGameViewV1 | null {
  if (!response) return null;
  const url = `${input.origin.replace(/\/+$/, '')}/stocks/weekend`;
  const round = response.round;
  const next = response.next;
  const nextLine = next ? `Round #${next.number} opens ${etLabelV1(next.opensAt)}.` : null;
  const error = input.failed ?? null;
  const baseRecord = response.baseRecord;
  const baseRecordTile: ReopenGameTileViewV1 | null =
    baseRecord.rounds > 0
      ? {
          key: 'base-record',
          label: "Base's record",
          value: `${baseRecord.correct}/${baseRecord.of}`,
          detail: `over ${plural(baseRecord.rounds, 'round', 'rounds')}`,
        }
      : null;

  if (!round) {
    if (!next) return null;
    return {
      state: 'upcoming',
      roundId: null,
      title: 'Call the reopen',
      badge: 'Next round',
      lede: `Round #${next.number} opens ${etLabelV1(next.opensAt)}, when Wall Street closes for the weekend: five stocks, and for each one question — will it reopen above or below ${etWeekdayV1(next.opensAt)}'s close? Picks close ${etLabelV1(next.locksAt)}, and Base makes its own call at the same minute.`,
      closeDay: null,
      rows: [],
      standing: null,
      keepWithWallet: false,
      rules: RULES_V1,
      share: null,
      error,
      leaderboard: reopenLeaderboardViewV1(response.leaderboard ?? null),
      cta: null,
      clock: clockV1(next.opensAt, `until round #${next.number} opens`, input.now),
      steps: stepsV1(next, input.now, false),
      tiles: baseRecordTile ? [baseRecordTile] : [],
      verdict: null,
    };
  }

  const me = response.me;
  const closeDay = closeDayV1(round.opensAt);
  const picks: Readonly<Record<string, ReopenDirectionV1>> = input.pending ?? me?.picks ?? {};
  const picked = Object.keys(picks).length > 0;
  const state = round.state;

  const rows = round.stocks.map((stock): ReopenGameRowViewV1 => {
    const pick = picks[stock.symbol] ?? null;
    const outcome = stock.result?.outcome ?? null;
    return {
      symbol: stock.symbol,
      name: stock.name,
      close: usdV1(stock.close),
      baseNow:
        state === 'open' && stock.baseNow
          ? `${usdV1(stock.baseNow.value)} · ${signedPercentV1(stock.baseNow.moveBps)}`
          : null,
      baseCall:
        state === 'open'
          ? null
          : stock.baseCall?.call && stock.baseCall.base
            ? `${ARROW_V1[stock.baseCall.call]} at ${usdV1(stock.baseCall.base)}`
            : stock.baseCall
              ? 'no call: too few quotes'
              : null,
      pick,
      crowd: stock.crowd ? `${stock.crowd.up} ▲ · ${stock.crowd.down} ▼` : null,
      result: stock.result
        ? stock.result.reopen
          ? `${stock.result.outcome === 'void' ? 'Reopened at the close' : `Reopened ${WORD_V1[stock.result.outcome]}`} · ${usdV1(stock.result.reopen)}`
          : 'No reopen print: counts for nobody'
        : null,
      mark:
        state !== 'settled' || outcome === null
          ? null
          : outcome === 'void' || pick === null
            ? '⬜'
            : pick === outcome
              ? '🟩'
              : '🟥',
      icon: input.icons?.get(stock.tokenAddress.toLowerCase()) ?? null,
    };
  });
  const pickedCount = rows.filter((row) => row.pick !== null).length;
  const steps = stepsV1(round, input.now, state === 'settled');

  const record = me?.record ?? null;
  const standing =
    me && !me.signed && (picked || (record?.played ?? 0) > 0)
      ? 'Your picks are kept on this device only. Sign in and they stay with your wallet, streak and all.'
      : me && me.signed && record && record.played > 0
        ? `Streak ${plural(record.streak, 'weekend', 'weekends')} · ${record.correct}/${record.of} right overall · beat Base ${plural(record.beatBase, 'time', 'times')}.`
        : me && me.signed && picked
          ? 'Your picks are kept with your wallet.'
          : state === 'open' && !picked
          ? 'Pick ▲ or ▼ for each stock. No wallet needed; you can change a pick until the lock.'
          : null;

  const shareCalls = rows
    .filter((row) => row.pick)
    .map((row) => `${row.symbol} ${ARROW_V1[row.pick!]}`)
    .join(' ');

  if (state === 'open') {
    return {
      state,
      roundId: round.roundId,
      title: `Call the reopen · #${round.number}`,
      badge: 'Picks open',
      closeDay,
      lede: `Will each stock reopen above or below ${closeDay.long}'s close? Picks close ${etLabelV1(round.locksAt)}. At that minute Base makes its own call from its price on Base, and the reopen at ${etLabelV1(round.expectedReopenAt)} settles both.`,
      rows,
      standing,
      keepWithWallet: Boolean(me && !me.signed && picked),
      rules: RULES_V1,
      share: picked
        ? giftShareLinksV1({
            url,
            text: `I'm calling the reopen against Base, #${round.number}: ${shareCalls}. Picks close ${etLabelV1(round.locksAt)}.`,
          })
        : null,
      error,
      leaderboard: reopenLeaderboardViewV1(response.leaderboard ?? null),
      cta: picked ? CTA_V1 : null,
      clock: clockV1(round.locksAt, 'until picks close', input.now),
      steps,
      tiles: [
        {
          key: 'mine',
          label: 'Your calls',
          value: `${pickedCount} of ${rows.length}`,
          detail: pickedCount === 0 ? 'no wallet needed' : 'yours to change until the lock',
          progress: rows.length > 0 ? pickedCount / rows.length : null,
        },
        ...(baseRecordTile ? [baseRecordTile] : []),
      ],
      verdict: null,
    };
  }

  if (state === 'locked') {
    const called = round.stocks.some((stock) => stock.baseCall !== null);
    const baseCalls = round.stocks.filter((stock) => stock.baseCall?.call).length;
    return {
      state,
      roundId: round.roundId,
      title: `Call the reopen · #${round.number}`,
      badge: 'Picks closed',
      closeDay,
      lede: `Picks closed ${etLabelV1(round.locksAt)}${round.players !== null ? `, with ${plural(round.players, 'player', 'players')}` : ''}. ${called ? "Base's calls are in." : "Base's call is being fixed from its price at the lock."} The reopen at ${etLabelV1(round.expectedReopenAt)} settles every call.`,
      rows,
      standing,
      keepWithWallet: Boolean(me && !me.signed && picked),
      rules: RULES_V1,
      share: null,
      error,
      leaderboard: reopenLeaderboardViewV1(response.leaderboard ?? null),
      cta: picked ? CTA_V1 : null,
      clock: clockV1(round.expectedReopenAt, 'until Wall Street reopens', input.now),
      steps,
      tiles: [
        ...(round.players !== null
          ? [{ key: 'players', label: 'Players', value: String(round.players), detail: 'made a call' }]
          : []),
        {
          key: 'mine',
          label: 'Your calls',
          value: pickedCount > 0 ? `${pickedCount} of ${rows.length}` : 'None',
          detail: pickedCount > 0 ? 'locked in' : 'you sat this one out',
        },
        ...(called
          ? [{ key: 'base', label: "Base's calls", value: `${baseCalls} of ${rows.length}`, detail: 'from its price at the lock' }]
          : []),
      ],
      verdict: null,
    };
  }

  // Settled.
  const base = round.score?.base ?? null;
  const crowd = round.score?.crowd ?? null;
  const mine = me?.score && picked ? me.score : null;
  const parts = [
    mine ? `You ${mine.correct}/${mine.of}` : null,
    base ? `Base ${base.correct}/${base.of}` : null,
    crowd ? `players ${crowd.correct}/${crowd.of}` : null,
  ].filter(Boolean);
  const players = round.players !== null ? `${plural(round.players, 'person', 'people')} played.` : '';
  const lede = [players, mine ? '' : 'You did not play this round.', nextLine ?? ''].filter(Boolean).join(' ');
  return {
    state,
    roundId: round.roundId,
    title: `Call the reopen · #${round.number}`,
    badge: 'Results',
    closeDay,
    lede: lede || `${parts.join(' · ')}.`,
    rows,
    standing,
    keepWithWallet: Boolean(me && !me.signed && (me.record.played ?? 0) > 0),
    rules: RULES_V1,
    // The post links to the reader's own result, whose page previews as a
    // picture of it; without a code, to the tab.
    share:
      mine && base
        ? giftShareLinksV1({
            url: me?.share ? `${url}?call=${me.share}` : url,
            text: reopenShareLineV1({ number: round.number, mine, base }),
          })
        : null,
    error,
    leaderboard: reopenLeaderboardViewV1(response.leaderboard ?? null),
    cta: picked ? CTA_V1 : null,
    clock: next ? clockV1(next.opensAt, `until round #${next.number} opens`, input.now) : null,
    steps,
    tiles: [
      ...(mine ? [{ key: 'mine', label: 'You', value: `${mine.correct}/${mine.of}`, detail: mine.cells }] : []),
      ...(base ? [{ key: 'base', label: 'Base', value: `${base.correct}/${base.of}`, detail: base.cells }] : []),
      ...(crowd ? [{ key: 'crowd', label: 'Players', value: `${crowd.correct}/${crowd.of}`, detail: crowd.cells }] : []),
    ],
    verdict:
      mine && base
        ? mine.correct > base.correct
          ? { text: 'You beat Base 🎉', tone: 'won' }
          : mine.correct < base.correct
            ? { text: 'Base won this round', tone: 'lost' }
            : { text: 'Level with Base', tone: 'level' }
        : null,
  };
}
