/**
 * Composer links: X takes the link as `url`, Farcaster as an embed, so the
 * text never carries it twice. A module of its own because Still's Home, in
 * the first bundle every visitor loads, shares by it too.
 */
export function composerLinksV1(input: { url: string; text: string }): { x: string; farcaster: string } {
  const text = encodeURIComponent(input.text);
  const url = encodeURIComponent(input.url);
  return {
    x: `https://x.com/intent/tweet?text=${text}&url=${url}`,
    // warpcast.com/~/compose now answers 301 to exactly this path, query intact.
    farcaster: `https://farcaster.xyz/~/compose?text=${text}&embeds[]=${url}`,
  };
}
