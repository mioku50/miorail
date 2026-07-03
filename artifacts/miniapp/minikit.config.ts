const ROOT_URL =
  process.env.NEXT_PUBLIC_URL ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  "http://localhost:3000";

/**
 * MiniApp configuration object. Must follow the mini app manifest specification.
 *
 * accountAssociation + baseBuilder are placeholders — fill them by running
 * `npx create-onchain --manifest` after registering on base.dev (see README).
 *
 * @see {@link https://docs.base.org/mini-apps/features/manifest}
 */
export const minikitConfig = {
  accountAssociation: {
    header: "",
    payload: "",
    signature: "",
  },
  baseBuilder: {
    ownerAddress: "",
  },
  miniapp: {
    version: "1",
    name: "MioAgent",
    subtitle: "Honest onchain agent cockpit",
    description:
      "MioAgent reviews your Base portfolio, flags risky tokens, and creates read-only recommendations — with honest states, x402 pay-per-action, and safe autonomy via session keys.",
    screenshotUrls: [],
    iconUrl: `${ROOT_URL}/icon.png`,
    splashImageUrl: `${ROOT_URL}/splash.png`,
    splashBackgroundColor: "#0A0B0F",
    homeUrl: ROOT_URL,
    webhookUrl: `${ROOT_URL}/api/webhook`,
    primaryCategory: "utility",
    tags: ["base", "agent", "portfolio", "security"],
    heroImageUrl: `${ROOT_URL}/hero.png`,
    tagline: "Honest onchain agent cockpit for Base",
    ogTitle: "MioAgent",
    ogDescription: "Honest onchain agent cockpit for Base — portfolio risk, x402, safe autonomy.",
    ogImageUrl: `${ROOT_URL}/hero.png`,
  },
} as const;
