// ---------------------------------------------------------------------------
// The Still team's own wallets (STILL_TEAM_WALLETS, comma separated).
//
// - The team's loans make no Loop, so the Loop numbers and counts are other
//   people's, and Loop #1 is the first real person's.
// - The team never enters a Loop draw.
// - The team's purchases go to Bitrefill without Still's affiliate code:
//   Bitrefill's affiliate terms (§14) forbid buying through one's own link.
//
// A value that is not an address is left out.
// ---------------------------------------------------------------------------

export function stillTeamWalletsV1(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.STILL_TEAM_WALLETS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter((value) => /^0x[0-9a-f]{40}$/.test(value)));
}
