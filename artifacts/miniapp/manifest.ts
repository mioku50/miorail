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
    subtitle: "Tokenized stocks, measured",
    description:
      "One security, every reviewed way to hold it on Base, and what getting in or out costs at an exact size. Measured router quotes and named gaps — never advice.",
    iconUrl: `${ROOT_URL}/icon.png`,
    splashImageUrl: `${ROOT_URL}/splash.png`,
    splashBackgroundColor: "#0A0B0F",
    homeUrl: ROOT_URL,
    primaryCategory: "utility",
    tags: ["base", "stocks", "rwa", "evidence"],
    heroImageUrl: `${ROOT_URL}/hero.png`,
    tagline: "Same underlying. Different market reality.",
    ogTitle: "Miorail",
    ogDescription: "Same underlying. Different representations. Different market reality.",
    ogImageUrl: `${ROOT_URL}/hero.png`,
  },
} as const;
