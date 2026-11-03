/**
 * Where a Still link made for a person goes when no request of theirs names a
 * host: a chat card's review and a purchase's share link. Still's one address
 * for people is miorail.xyz (operator, 2026-11-03). stills.lat leads people
 * there with a 302 and still answers machines: /mcp/still, the API and OAuth.
 * The pages' switch is lib/ui/src/stillOrigin.ts and the preview image is named
 * in artifacts/interface/index.html; stillOrigin.test.ts keeps the three equal.
 * Should miorail.xyz ever be held as stills.lat was on 2026-11-02, set the
 * three to https://stills.lat and lift the 302.
 */
export const STILL_PUBLIC_ORIGIN_V1 = 'https://miorail.xyz';
/** The same, as the MCP servers name it to an assistant. */
export const STILL_PUBLIC_HOST_V1 = STILL_PUBLIC_ORIGIN_V1.replace(/^https:\/\//, '');
