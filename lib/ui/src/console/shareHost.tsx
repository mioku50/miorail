import React from 'react';

// ---------------------------------------------------------------------------
// Sharing from inside an app that hosts the page.
//
// The share buttons are links to each network's own composer, which is right
// in a browser. Inside Farcaster it is wrong: the page runs in Farcaster's own
// webview, where farcaster.xyz/~/compose is only a web page, and on a phone
// that page asks you to download the app you are already in (the operator,
// sharing the weekend card on 2026-10-11).
//
// A host that composes casts itself is handed in here. The same buttons then
// ask it, with the text and link the composer link already carries, and open
// any other link through the host rather than inside its webview. Without a
// host they stay plain links.
// ---------------------------------------------------------------------------

export interface ShareCastV1 {
  text: string;
  /** At most two: Farcaster's limit. */
  embeds: string[];
}

export interface ShareHostV1 {
  composeCast(cast: ShareCastV1): Promise<void>;
  openUrl(url: string): Promise<void>;
}

const ShareHostContextV1 = React.createContext<ShareHostV1 | null>(null);

export const ShareHostProviderV1 = ShareHostContextV1.Provider;

export function useShareHostV1(): ShareHostV1 | null {
  return React.useContext(ShareHostContextV1);
}

/** What a Farcaster composer link carries, or null for any other link. */
export function castFromComposeHrefV1(href: string): ShareCastV1 | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !['farcaster.xyz', 'warpcast.com'].includes(url.hostname)) return null;
  if (url.pathname !== '/~/compose') return null;
  return { text: url.searchParams.get('text') ?? '', embeds: url.searchParams.getAll('embeds[]').slice(0, 2) };
}

/**
 * The click a share link makes inside a host: a cast composed by the host,
 * any other link opened by it. If the host refuses, the link itself is still
 * the way out, opened by the host too.
 */
export function shareClickV1(host: ShareHostV1, href: string): (event: { preventDefault(): void }) => void {
  return (event) => {
    event.preventDefault();
    const cast = castFromComposeHrefV1(href);
    const asked = cast ? host.composeCast(cast) : host.openUrl(href);
    void asked.catch(() => (cast ? host.openUrl(href) : undefined)).catch(() => undefined);
  };
}

export function ShareLinkV1({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: React.ReactNode;
}) {
  const host = useShareHostV1();
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={host ? shareClickV1(host, href) : undefined}
    >
      {children}
    </a>
  );
}
