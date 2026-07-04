const ROOT_URL =
  process.env.NEXT_PUBLIC_URL ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  "http://localhost:3000";

/**
 * App manifest — drives the optional Farcaster distribution manifest
 * (/.well-known/farcaster.json) and the fc:miniapp meta tag in app/layout.tsx.
 *
 * This is a STATIC distribution surface only — no Farcaster runtime SDK is
 * imported anywhere in the app. accountAssociation + baseBuilder are JFS
 * placeholders; fill them by running `npx create-onchain --manifest` after
 * registering on base.dev (see README).
 *
 * Lives at the package root (not app/) so it does NOT collide with Next.js's
 * reserved `app/manifest.ts` metadata-route convention.
 */
export const appManifest = {
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
    name: "Miorail",
    subtitle: "Autonomous Base agent on rails",
    description:
      "Miorail reviews your Base portfolio, flags risky tokens, and creates read-only recommendations — with honest states, x402 pay-per-action, and safe autonomy via session keys.",
    iconUrl: `${ROOT_URL}/icon.png`,
    splashImageUrl: `${ROOT_URL}/splash.png`,
    splashBackgroundColor: "#0A0B0F",
    homeUrl: ROOT_URL,
    primaryCategory: "utility",
    tags: ["base", "agent", "portfolio", "security"],
    heroImageUrl: `${ROOT_URL}/hero.png`,
    tagline: "Autonomous Base agent on rails — safe autonomy, x402 metering",
    ogTitle: "Miorail",
    ogDescription: "Autonomous Base agent on rails — portfolio risk, x402, safe autonomy.",
    ogImageUrl: `${ROOT_URL}/hero.png`,
  },
} as const;
