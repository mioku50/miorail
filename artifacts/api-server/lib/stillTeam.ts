// ---------------------------------------------------------------------------
// The Still team's own wallets (STILL_TEAM_WALLETS, comma separated), and only
// the wallets the list names:
//
// - a listed wallet's loans make no Loop, so the Loop numbers and counts are
//   other people's;
// - a listed wallet cannot enter a Loop draw;
// - a listed wallet's purchases go to Bitrefill without Still's affiliate code:
//   Bitrefill's affiliate terms (§14) forbid buying through one's own link.
//
// Production keeps the list empty (the operator's choice, 2026-11-20). None of
// this then applies: every purchase carries the affiliate code, the team's own
// included, and the team stays out of the draws by its word, not by this code
// (audit 11-20 SPEND-2).
//
// A value that is not an address is left out.
// ---------------------------------------------------------------------------

export function stillTeamWalletsV1(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.STILL_TEAM_WALLETS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter((value) => /^0x[0-9a-f]{40}$/.test(value)));
}
