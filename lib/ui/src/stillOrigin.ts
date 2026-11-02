/**
 * Where Still's pages send people: a wallet's and a purchase's share links,
 * the Still MCP address, the icon a chat card hands the wallet. Still's own
 * door is stills.lat; while that name does not resolve (since 2026-11-02) they
 * go to miorail.xyz, which serves the same app. The API holds the same switch
 * (artifacts/api-server/lib/stillOrigin.ts), and its test keeps the two equal.
 */
export const STILL_PUBLIC_ORIGIN_V1 = 'https://miorail.xyz';
/** The same, as a sentence names it. */
export const STILL_PUBLIC_HOST_V1 = STILL_PUBLIC_ORIGIN_V1.replace(/^https:\/\//, '');
