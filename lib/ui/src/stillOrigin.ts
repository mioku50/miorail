/**
 * Where Still's pages send people: a wallet's and a purchase's share links,
 * the Still MCP address, the icon a chat card hands the wallet. Still's one
 * address is miorail.xyz (since 2026-11-03), and stills.lat leads there. The
 * API holds the same switch (artifacts/api-server/lib/stillOrigin.ts), and its
 * test keeps the two equal.
 */
export const STILL_PUBLIC_ORIGIN_V1 = 'https://miorail.xyz';
/** The same, as a sentence names it. */
export const STILL_PUBLIC_HOST_V1 = STILL_PUBLIC_ORIGIN_V1.replace(/^https:\/\//, '');
