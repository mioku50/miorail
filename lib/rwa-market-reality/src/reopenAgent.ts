import { z } from 'zod';

import {
  REOPEN_LINEUP_V1,
  ReopenGameResponseV1Schema,
  type ReopenDirectionV1,
  type ReopenGameResponseV1,
} from './reopenGame.js';
import { etClockLabelV1, etWeekdayV1 } from './weekendMarket.js';

// ---------------------------------------------------------------------------
// Call the reopen, for an assistant.
//
// The same round the Weekend tab shows, from the same cached read, so an
// assistant and the page cannot disagree about a pick, a call or a result.
// The words an assistant is most likely to bend are written here: Base's
// price over the weekend is where the token trades, never a forecast; Base's
// call is fixed at the lock, never before; and nothing is won but the record.
//
// A pick is made by a person. The public read takes no wallet and makes none;
// the connected surface picks for the one wallet its grant names, and only
// for the stocks the person named.
// ---------------------------------------------------------------------------

export const REOPEN_PLAY_URL_V1 = 'https://miorail.xyz/stocks/weekend';

export const REOPEN_AGENT_RULES_V1 =
  'Each weekend, five stocks (NVDA, TSLA, AAPL, AMZN, MSTR) and one question each: will it reopen above or below the close? The close is the Chainlink price at the last bell before the weekend: Friday 16:00 ET, Thursday before a holiday Friday, 13:00 ET on a short day. Picks close Sunday 17:00 ET, three hours before Wall Street reopens at 20:00 ET, because futures open at 18:00 ET and show the way. At the lock Base makes its own call from its price on Base: the median of Miorail’s $100 quotes over the six hours before. The first Chainlink price Miorail records after the reopen settles every call; a stock that reopens exactly at the close, or does not print, counts for nobody. No prizes: the tokens are not offered to US persons, and the game is played for the record.';

/** The public read takes nothing. */
export const ReopenRoundAgentInputV1Schema = z.object({}).strict();
export type ReopenRoundAgentInputV1 = z.infer<typeof ReopenRoundAgentInputV1Schema>;

const AgentFieldsV1 = {
  /** "Friday", or "Thursday" before a holiday Friday; null with no round. */
  closeDay: z.string().nullable(),
  rules: z.string(),
  playUrl: z.string().url(),
  /** Read first, and prefer its wording. */
  miorailSummary: z.string(),
};

export const ReopenRoundAgentOutputV1Schema = ReopenGameResponseV1Schema.omit({ me: true }).extend(AgentFieldsV1);
export type ReopenRoundAgentOutputV1 = z.infer<typeof ReopenRoundAgentOutputV1Schema>;

/** The connected surface's answer: the same round, and this wallet's own part. */
export const ReopenMineAgentOutputV1Schema = ReopenGameResponseV1Schema.extend(AgentFieldsV1);
export type ReopenMineAgentOutputV1 = z.infer<typeof ReopenMineAgentOutputV1Schema>;

const SideArgV1 = z
  .enum(['above', 'below'])
  .describe('Whether this stock will reopen above or below the close. Only what the user said; never a guess of yours.');

/** One optional answer per lineup stock. A stock not named keeps its pick. */
export const ReopenCallAgentInputV1Schema = z
  .object({
    NVDA: SideArgV1.optional(),
    TSLA: SideArgV1.optional(),
    AAPL: SideArgV1.optional(),
    AMZN: SideArgV1.optional(),
    MSTR: SideArgV1.optional(),
  })
  .strict();
export type ReopenCallAgentInputV1 = z.infer<typeof ReopenCallAgentInputV1Schema>;

/** The named answers as the game stores them, or null when none was named. */
export function reopenAgentPicksV1(input: ReopenCallAgentInputV1): Record<string, ReopenDirectionV1> | null {
  const picks: Record<string, ReopenDirectionV1> = {};
  for (const symbol of REOPEN_LINEUP_V1) {
    const side = input[symbol];
    if (side) picks[symbol] = side === 'above' ? 'up' : 'down';
  }
  return Object.keys(picks).length > 0 ? picks : null;
}

const SIDE_WORD_V1: Readonly<Record<ReopenDirectionV1, string>> = { up: 'above', down: 'below' };

function usdV1(value: string): string {
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percentV1(bps: number): string {
  const value = (Math.abs(bps) / 100).toFixed(2);
  return bps > 0 ? `+${value}%` : bps < 0 ? `-${value}%` : `${value}%`;
}

function list(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "Sun 17:00 ET (2026-10-11T21:00:00.000Z)": the clock a person reads and the
 * instant an assistant can convert. */
function whenV1(iso: string): string {
  return `${etClockLabelV1(iso)} (${iso})`;
}

/**
 * The round in sentences, every number in them on a row of the answer. What
 * a reader's own picks were is said only on the connected surface.
 */
export function reopenRoundSummaryV1(response: ReopenGameResponseV1): string {
  const round = response.round;
  const next = response.next;
  const sentences: string[] = [];
  const nextLine = next
    ? `Round #${next.number} opens ${whenV1(next.opensAt)}, and its picks close ${whenV1(next.locksAt)}.`
    : "No next round is scheduled yet: Miorail's reviewed market calendar ends before the next weekend.";
  if (!round) {
    sentences.push(nextLine);
  } else {
    const close = `${etWeekdayV1(round.opensAt)}'s close`;
    if (round.state === 'open') {
      const lines = round.stocks.map((stock) => `${stock.symbol} closed at ${usdV1(stock.close)}`);
      const onBase = round.stocks
        .filter((stock) => stock.baseNow)
        .map((stock) => `${stock.symbol} ${percentV1(stock.baseNow!.moveBps)}`);
      sentences.push(
        `Round #${round.number} is open: will each stock reopen above or below ${close}? ${list(lines)}.`,
        `Picks close ${whenV1(round.locksAt)}; at that minute Base makes its own call from its price on Base, and the reopen at ${whenV1(round.expectedReopenAt)} settles every call.`,
      );
      if (onBase.length > 0) {
        sentences.push(
          `On Base right now, against ${close}: ${list(onBase)}. That is where the tokens trade over the weekend, not a forecast of the reopen, and not Base's call, which is fixed only at the lock.`,
        );
      }
      sentences.push('How other players picked is hidden until the lock.');
    } else if (round.state === 'locked') {
      const called = round.stocks
        .filter((stock) => stock.baseCall)
        .map((stock) =>
          stock.baseCall!.call ? `${stock.symbol} ${SIDE_WORD_V1[stock.baseCall!.call]}` : `${stock.symbol} no call (too few quotes)`,
        );
      sentences.push(
        `Round #${round.number}: picks closed ${whenV1(round.locksAt)}${round.players !== null ? ` with ${round.players} ${round.players === 1 ? 'player' : 'players'}` : ''}.`,
        called.length > 0
          ? `Base called ${list(called)} against ${close}.`
          : "Base's call is being fixed from its price at the lock.",
        `The reopen at ${whenV1(round.expectedReopenAt)} settles every call.`,
      );
    } else {
      const results = round.stocks.map((stock) => {
        const result = stock.result;
        const reopened = !result
          ? 'did not settle'
          : !result.reopen
            ? 'had no reopen print and counts for nobody'
            : result.outcome === 'void'
              ? `reopened exactly at the close (${usdV1(result.reopen)}) and counts for nobody`
              : `reopened ${SIDE_WORD_V1[result.outcome]} at ${usdV1(result.reopen)}`;
        const base = stock.baseCall?.call ? `; Base had called ${SIDE_WORD_V1[stock.baseCall.call]}` : '';
        return `${stock.symbol} ${reopened}${base}`;
      });
      const base = round.score?.base;
      const crowd = round.score?.crowd;
      sentences.push(
        `Round #${round.number} is settled, against ${close}: ${results.join('; ')}.`,
        `${base ? `Base got ${base.correct} of ${base.of}` : 'Base has no score'}${crowd ? `; the players' majority got ${crowd.correct} of ${crowd.of}` : ''}${round.players !== null ? `; ${round.players} ${round.players === 1 ? 'person' : 'people'} played` : ''}.`,
        nextLine,
      );
    }
  }
  const record = response.baseRecord;
  if (record.rounds > 0) {
    sentences.push(
      `Base's record over ${record.rounds} settled ${record.rounds === 1 ? 'round' : 'rounds'}: ${record.correct} of ${record.of}.`,
    );
  }
  const board = response.leaderboard;
  if (board && board.rows.length > 0) {
    const top = board.rows.slice(0, 3).map((row) => `#${row.rank} ${row.name} ${row.correct}/${row.of}`);
    sentences.push(
      `Leaderboard after ${board.rounds} ${board.rounds === 1 ? 'round' : 'rounds'} and ${board.players} ${board.players === 1 ? 'player' : 'players'}: ${list(top)}. A wallet with a Basename is listed by it, everybody else by player number.`,
    );
  }
  sentences.push('Nothing is won but the record.');
  return sentences.join(' ');
}

/** The reader's own part, in sentences, for the connected surface. */
export function reopenMineSummaryV1(response: ReopenGameResponseV1): string {
  const me = response.me;
  const round = response.round;
  if (!me) return 'This wallet has never picked in Call the reopen.';
  const sentences: string[] = [];
  const picks = Object.entries(me.picks).map(([symbol, side]) => `${symbol} ${SIDE_WORD_V1[side]}`);
  if (round) {
    sentences.push(
      picks.length > 0
        ? `This wallet's picks in round #${round.number}: ${list(picks)}.`
        : `This wallet has no picks in round #${round.number}.`,
    );
  }
  if (me.score) sentences.push(`It called ${me.score.correct} of ${me.score.of} in that round.`);
  const record = me.record;
  if (record.played > 0) {
    sentences.push(
      `Across ${record.played} ${record.played === 1 ? 'round' : 'rounds'}: ${record.correct} of ${record.of} right, a streak of ${record.streak} ${record.streak === 1 ? 'weekend' : 'weekends'}, ahead of Base ${record.beatBase} ${record.beatBase === 1 ? 'time' : 'times'}.`,
    );
  }
  const place = response.leaderboard?.me;
  if (place && response.leaderboard) {
    sentences.push(`On the leaderboard it is #${place.rank} of ${response.leaderboard.players}.`);
  }
  return sentences.join(' ');
}

function agentFieldsV1(response: ReopenGameResponseV1) {
  return {
    closeDay: response.round
      ? etWeekdayV1(response.round.opensAt)
      : response.next
        ? etWeekdayV1(response.next.opensAt)
        : null,
    rules: REOPEN_AGENT_RULES_V1,
    playUrl: REOPEN_PLAY_URL_V1,
  };
}

/** The public answer: no reader, so nobody's picks. */
export function reopenRoundForAgentV1(response: ReopenGameResponseV1): ReopenRoundAgentOutputV1 {
  const { me: _me, ...shared } = response;
  void _me;
  const everyone = { ...shared, me: null };
  return ReopenRoundAgentOutputV1Schema.parse({
    ...shared,
    ...agentFieldsV1(everyone),
    miorailSummary: reopenRoundSummaryV1(everyone),
  });
}

/** The connected answer: the round, and the grant's own wallet in it. */
export function reopenMineForAgentV1(response: ReopenGameResponseV1): ReopenMineAgentOutputV1 {
  return ReopenMineAgentOutputV1Schema.parse({
    ...response,
    ...agentFieldsV1(response),
    miorailSummary: `${reopenMineSummaryV1(response)} ${reopenRoundSummaryV1(response)}`,
  });
}
