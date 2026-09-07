/**
 * What each reviewed read comes back with, in one sentence.
 *
 * An example prompt sets an expectation; the answer either meets it or
 * contradicts it. GMGN advertised a per-token report its API does not have and
 * the reader blamed the provider — the failure was ours, and it happened
 * because the shape of the answer was invisible until it arrived.
 *
 * These sentences live in the same module as the recipes so they are written
 * from the call, not from the plugin's marketing summary: a list is a list, ten
 * rows are ten rows, and a per-chain table says which chains. They are asserted
 * against the released reads in a test, so a recipe that changes what it
 * fetches cannot quietly keep an old promise.
 */
export interface ReviewedReadFactsV1 {
  /** What the read comes back with. */
  returns: string;
  /**
   * The read runs as the READER, after they sign in to the provider.
   *
   * A property of the recipe, never of the plugin's spec. Base's frontmatter
   * describes a whole plugin — Venice's says `siwe-jwt` because inference needs
   * an account, while the model catalogue this recipe reads answers 200 to
   * nobody in particular, and Bitrefill's browse reaches the catalogue without
   * one. Only Virtuals actually loads a session before it asks.
   */
  needsProviderSignIn?: true;
}

export const REVIEWED_READ_FACTS_V1: Readonly<Record<string, ReviewedReadFactsV1>> = {
  'avantis:positions': { returns: 'Your open Avantis positions and their PnL, for the wallet you connected.' },
  'balancer:yield': { returns: 'Balancer pools on Base ranked by yield, from a pinned pool query.' },
  'bankr:latest': { returns: 'The ten most recent Bankr launches on Base.' },
  'bankr:inspect': { returns: 'Bankr’s record for one Base token address you paste — no address, no request.' },
  'bitrefill:search': { returns: 'Bitrefill products matching what you asked for. Sign-in to Bitrefill is yours, not Miorail’s.' },
  'bitrefill:browse': { returns: 'The Bitrefill catalogue for one country. Sign-in to Bitrefill is yours, not Miorail’s.' },
  'clawnch:latest': { returns: 'The ten most recent Clawnch launches.' },
  'clawnch:volume': { returns: 'Ten Clawnch tokens ranked by volume, with prices.' },
  'flaunch:latest': { returns: 'The newest Flaunch coins on Base.' },
  'gmgn:market': { returns: 'GMGN’s own list: ten Base tokens by one-hour volume. Not a report about one token — its only per-token endpoint returns swap calldata, which this surface does not release.' },
  'moonwell:markets': { returns: 'Moonwell supply and borrow rates on Base for the one asset you name.' },
  'moonwell:health': { returns: 'Your Moonwell positions and health factor, for the wallet you connected.' },
  'opensea:drops': { returns: 'Ten popular Base collections by seven-day volume. Not upcoming drops.' },
  'opensea:listing': { returns: 'A pointer into the NFT route family, where one listing is priced under its own checks — this read lists collections only.' },
  'printr:cost': { returns: 'Printr’s launch cost per chain for the chains, initial buy and graduation target you name.' },
  'printr:status': { returns: 'Printr’s per-chain deployment state for one token id — live, pending or failed.' },
  'venice:models': { returns: 'The models Venice publishes, with what each one does.' },
  'virtuals:agents': { returns: 'The Virtuals agents your signed-in account owns.', needsProviderSignIn: true },
};

export function reviewedReadShapeV1(pluginId: string, exampleId: string): string | null {
  return REVIEWED_READ_FACTS_V1[`${pluginId}:${exampleId}`]?.returns ?? null;
}

/** Plugin ids with at least one reviewed read that runs as the reader. */
export function reviewedReadsNeedingSignInV1(): readonly string[] {
  return [
    ...new Set(
      Object.entries(REVIEWED_READ_FACTS_V1)
        .filter(([, facts]) => facts.needsProviderSignIn)
        .map(([key]) => key.split(':')[0]!),
    ),
  ];
}
