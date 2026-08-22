// ---------------------------------------------------------------------------
// Where a plugin's own interface lives.
//
// A console answer often ends where Miorail's authority ends: Miorail can read
// Venice's catalogue but not run inference for you, can list an OpenSea
// collection but not walk you through a purchase there. The honest next step is
// a link to the provider — and the one thing that must never produce that link
// is the model. "Probably venice.ai/models" is a guess with a URL's authority,
// and a guessed URL in a product that sends people to sign transactions is not
// a cosmetic error.
//
// So links come from here: a code-owned table, keyed by the plugin id the
// router already resolved. `deepPath` builders take an identifier the reviewed
// reply builder actually READ from a provider response, never a string the
// model produced, and every result is re-pinned to the entry's own host before
// it is returned. A builder that cannot form a safe path returns the entry's
// home page rather than an approximation of a deep link.
//
// Rules for WHERE a CTA may appear live with the caller, not here:
//   READ         — Miorail keeps the answer; the CTA is secondary.
//   PROVIDER UI  — the CTA is the next step, because the write finishes there.
//   ROUTES AI    — no CTA. A routable intent finishes in Miorail, and pointing
//                  the user at the provider because our own simulator or
//                  adapter fell short exports our gap to them as a chore.
// ---------------------------------------------------------------------------

export interface BaseMcpProviderLinkV1 {
  /** Button text. Names the destination and what is there. */
  label: string;
  url: string;
}

interface ProviderLinkSpecV1 {
  host: string;
  home: string;
  label: string;
  /** Builds a path for one object. Returns null when the id is unusable. */
  deepPath?: (id: string) => string | null;
  /** Label for the deep link, given the object's display name. */
  deepLabel?: (name: string) => string;
}

/** Lowercase hex address, the only id shape we ever put in a provider path. */
const ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
/** A conservative slug: OpenSea collection slugs and Venice model ids fit. */
const SLUG_V1 = /^[a-z0-9][a-z0-9._-]{0,80}$/;

function addressPath(prefix: string): (id: string) => string | null {
  return (id) => {
    const clean = id.trim().toLowerCase();
    return ADDRESS_V1.test(clean) ? `${prefix}${clean}` : null;
  };
}

function slugPath(prefix: string): (id: string) => string | null {
  return (id) => {
    const clean = id.trim().toLowerCase();
    return SLUG_V1.test(clean) ? `${prefix}${clean}` : null;
  };
}

const PROVIDER_LINKS_V1: Readonly<Record<string, ProviderLinkSpecV1>> = Object.freeze({
  aerodrome: { host: 'aerodrome.finance', home: 'https://aerodrome.finance/', label: 'Open Aerodrome' },
  avantis: { host: 'www.avantisfi.com', home: 'https://www.avantisfi.com/trade', label: 'Continue in Avantis' },
  balancer: {
    host: 'balancer.fi',
    home: 'https://balancer.fi/pools',
    label: 'Explore pools on Balancer',
    deepPath: slugPath('/pools/base/v3/'),
    deepLabel: (name) => `View ${name} on Balancer`,
  },
  bankr: { host: 'bankr.bot', home: 'https://bankr.bot/', label: 'Open Bankr' },
  bitrefill: { host: 'www.bitrefill.com', home: 'https://www.bitrefill.com/', label: 'Open Bitrefill' },
  brickken: { host: 'www.brickken.com', home: 'https://www.brickken.com/', label: 'Open Brickken' },
  clawnch: { host: 'www.clawn.ch', home: 'https://www.clawn.ch/', label: 'Open Clawnch' },
  flaunch: { host: 'flaunch.gg', home: 'https://flaunch.gg/', label: 'Open Flaunch' },
  gmgn: {
    host: 'gmgn.ai',
    home: 'https://gmgn.ai/?chain=base',
    label: 'Open GMGN',
    deepPath: addressPath('/base/token/'),
    deepLabel: (name) => `View ${name} on GMGN`,
  },
  hydrex: { host: 'hydrex.finance', home: 'https://hydrex.finance/', label: 'Open Hydrex' },
  kyberswap: { host: 'kyberswap.com', home: 'https://kyberswap.com/', label: 'Open KyberSwap' },
  moonwell: { host: 'moonwell.fi', home: 'https://moonwell.fi/markets', label: 'Open Moonwell' },
  morpho: { host: 'app.morpho.org', home: 'https://app.morpho.org/base/earn', label: 'Open Morpho' },
  'o1-exchange': { host: 'o1.exchange', home: 'https://o1.exchange/', label: 'Open o1.exchange' },
  opensea: {
    host: 'opensea.io',
    home: 'https://opensea.io/',
    label: 'Open OpenSea',
    deepPath: slugPath('/collection/'),
    deepLabel: (name) => `View ${name} on OpenSea`,
  },
  printr: { host: 'printr.money', home: 'https://printr.money/', label: 'Open Printr' },
  uniswap: { host: 'app.uniswap.org', home: 'https://app.uniswap.org/', label: 'Open Uniswap' },
  venice: { host: 'venice.ai', home: 'https://venice.ai/models', label: 'Explore models on Venice' },
  virtuals: { host: 'app.virtuals.io', home: 'https://app.virtuals.io/', label: 'Open Virtuals' },
  yo: { host: 'yo.xyz', home: 'https://yo.xyz/', label: 'Open Yo' },
});

/** Every host this table can ever produce, for a test that pins the boundary. */
export const BASE_MCP_PROVIDER_LINK_HOSTS_V1: readonly string[] = Object.freeze(
  [...new Set(Object.values(PROVIDER_LINKS_V1).map((entry) => entry.host))].sort(),
);

export interface ProviderCtaInputV1 {
  pluginId: string;
  /** An identifier a reviewed reply builder read from a provider response. */
  objectId?: string | null;
  /** What to call that object in the button. */
  objectName?: string | null;
}

/**
 * The CTA for a plugin, or null when there is no reviewed destination.
 *
 * Fails closed twice: an unknown plugin gets nothing, and a built URL whose
 * host is not the entry's own host is discarded rather than returned. The
 * second check is redundant today — every path is relative to a pinned home —
 * and it stays because the day it stops being redundant is the day it matters.
 */
export function baseMcpProviderCtaV1(input: ProviderCtaInputV1): BaseMcpProviderLinkV1 | null {
  const spec = PROVIDER_LINKS_V1[input.pluginId];
  if (!spec) return null;

  const home: BaseMcpProviderLinkV1 = { label: spec.label, url: spec.home };
  const id = input.objectId?.trim();
  if (!id || !spec.deepPath) return home;

  const path = spec.deepPath(id);
  if (!path) return home;

  let url: URL;
  try {
    url = new URL(path, `https://${spec.host}`);
  } catch {
    return home;
  }
  // The pin. A path that resolved anywhere but this provider is not this
  // provider's deep link, whatever it claims to be.
  if (url.protocol !== 'https:' || url.host !== spec.host) return home;

  const name = input.objectName?.trim();
  return {
    label: name && spec.deepLabel ? spec.deepLabel(name.slice(0, 40)) : spec.label,
    url: url.toString(),
  };
}
