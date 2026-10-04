import { InMemoryRateLimiter } from '@mioagent/utils';
import {
  reopenAgentPicksV1,
  reopenMineForAgentV1,
  type ReopenCallAgentInputV1,
  type ReopenMineAgentOutputV1,
} from '@mioagent/rwa-market-reality/reopen-agent';
import { reopenGameForV1 } from '@mioagent/rwa-market-reality/reopen-game-service';
import { etClockLabelV1 } from '@mioagent/rwa-market-reality/weekend-market';

import { reopenGameRuntime, reopenSharedNowV1 } from '../routes/reopenGame.js';

// ---------------------------------------------------------------------------
// Call the reopen for the one wallet a connected grant names.
//
// The read and the pick go through the same repository and the same cached
// round as the Weekend tab, and a pick lands under the same rule: only before
// the lock, checked in the statement that writes it. An assistant names the
// stocks the person named; a stock it does not name keeps whatever was picked
// for it before, so "change TSLA" never clears the other four.
// ---------------------------------------------------------------------------

/** A refusal an assistant can repeat to the person: what happened, and that
 * nothing changed. */
export class ReopenAgentErrorV1 extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReopenAgentErrorV1';
  }
}

/** The page's own budget for picks, per wallet instead of per address. */
const callLimiter = new InMemoryRateLimiter({ windowMs: 60_000, max: 20 });

async function availableV1(): Promise<void> {
  if (!reopenGameRuntime.enabled(process.env) || !(await reopenGameRuntime.storageAvailable())) {
    throw new ReopenAgentErrorV1(
      'reopen_game_unavailable',
      'Call the reopen could not be read right now. No pick was read or changed.',
    );
  }
}

function playerIdOfV1(wallet: string): string {
  return `w:${wallet.toLowerCase()}`;
}

/** This wallet's picks in the round on show, its score and its record. */
export async function readMyReopenV1(wallet: string): Promise<ReopenMineAgentOutputV1> {
  await availableV1();
  const now = reopenGameRuntime.now();
  const repository = reopenGameRuntime.repository();
  const shared = await reopenSharedNowV1(now);
  // Reading creates nothing: a wallet that never played reads as no picks.
  const response = await reopenGameForV1({
    shared,
    player: { playerId: playerIdOfV1(wallet), signed: true },
    now,
    repository,
  });
  return reopenMineForAgentV1(response);
}

/** Picks for the open round, for the stocks named; the others keep theirs. */
export async function callTheReopenV1(wallet: string, input: ReopenCallAgentInputV1): Promise<ReopenMineAgentOutputV1> {
  const named = reopenAgentPicksV1(input);
  if (!named) {
    throw new ReopenAgentErrorV1(
      'no_pick_named',
      'Name at least one stock and whether it reopens above or below the close. Nothing was changed.',
    );
  }
  const address = wallet.toLowerCase();
  const allowed = await callLimiter.consume(`reopen-mcp:${address}`);
  if (!allowed.success) {
    throw new ReopenAgentErrorV1('rate_limited', 'Too many picks from this wallet in one minute. Nothing was changed.');
  }
  await availableV1();
  const now = reopenGameRuntime.now();
  const repository = reopenGameRuntime.repository();
  const shared = await reopenSharedNowV1(now);
  const round = shared.round;
  const next = shared.next;
  const nextLine = next ? ` Round #${next.number} opens ${etClockLabelV1(next.opensAt)} (${next.opensAt}).` : '';
  if (!round || round.state === 'settled') {
    throw new ReopenAgentErrorV1('round_not_open', `No round is taking picks right now.${nextLine} Nothing was changed.`);
  }
  if (round.state !== 'open' || now.getTime() >= Date.parse(round.locksAt)) {
    throw new ReopenAgentErrorV1(
      'round_locked',
      `Picks for round #${round.number} closed ${etClockLabelV1(round.locksAt)}.${nextLine} Nothing was changed.`,
    );
  }
  const inRound = new Set(round.stocks.map((stock) => stock.symbol));
  const absent = Object.keys(named).filter((symbol) => !inRound.has(symbol));
  if (absent.length > 0) {
    throw new ReopenAgentErrorV1(
      'stock_not_in_round',
      `${absent.join(' and ')} ${absent.length === 1 ? 'is' : 'are'} not in round #${round.number}: the feed had no close to ask about. Nothing was changed.`,
    );
  }

  const playerId = await repository.walletPlayer({ wallet: address, now });
  const before = (await repository.picksOf(playerId)).find((row) => row.roundId === round.roundId)?.picks ?? {};
  const saved = await repository.savePicks({ roundId: round.roundId, playerId, picks: { ...before, ...named }, now });
  if (saved !== 'saved') {
    throw new ReopenAgentErrorV1(
      saved === 'locked' ? 'round_locked' : 'round_not_open',
      saved === 'locked'
        ? `Picks for round #${round.number} closed ${etClockLabelV1(round.locksAt)}. Nothing was changed.`
        : `No round is taking picks right now.${nextLine} Nothing was changed.`,
    );
  }
  const response = await reopenGameForV1({ shared, player: { playerId, signed: true }, now, repository });
  return reopenMineForAgentV1(response);
}
