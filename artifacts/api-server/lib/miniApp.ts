// ---------------------------------------------------------------------------
// Miorail as a Farcaster mini app: what a cast shows, and what it opens.
//
// A link posted in Farcaster is shown as the page's `fc:miniapp` embed: a 3:2
// picture and one button. The button opens the page INSIDE Farcaster, where
// the page can ask Farcaster to compose a cast or connect its wallet. Without
// the embed the link opened in Farcaster's in-app browser, where sharing
// meant farcaster.xyz/~/compose, a web page that on a phone asks you to
// download the app you are already in (the operator, 2026-10-11).
//
// Spec: miniapps.farcaster.xyz/docs/specification. The button's title is at
// most 32 characters. With no `url` the button opens the page the embed came
// from, query included, which is what every page here wants.
// ---------------------------------------------------------------------------

export const MINI_APP_NAME_V1 = 'Miorail';
/** The page colour (index.html's theme-color), behind the splash icon. */
export const MINI_APP_SPLASH_BACKGROUND_V1 = '#070A17';
export const MINI_APP_BUTTON_TITLE_MAX_V1 = 32;
/** What a button says when the one it was given is longer than Farcaster takes. */
const MINI_APP_FALLBACK_TITLE_V1 = 'Open Miorail';

export function miniAppIconUrlV1(origin: string): string {
  return `${origin}/miniapp-icon.png`;
}

export function miniAppSplashUrlV1(origin: string): string {
  return `${origin}/miniapp-splash.png`;
}

export type MiniAppEmbedV1 = {
  /** Absolute, on this site, and 3:2. */
  imageUrl: string;
  buttonTitle: string;
  /**
   * Where the button opens, when it is not the page itself. A stills.lat page
   * opens its miorail.xyz twin: the mini app is registered for that domain,
   * and Farcaster checks the domain it launches against its manifest.
   */
  url?: string;
};

/**
 * The embed as Farcaster reads it. `launch_miniapp` is the current action;
 * clients that still read the older `fc:frame` tag know it as `launch_frame`.
 *
 * Never throws: a head is an improvement to a page, not a precondition for it.
 * The splash is the icon on this site, found from the picture's own origin.
 */
export function miniAppEmbedJsonV1(embed: MiniAppEmbedV1, type: 'launch_miniapp' | 'launch_frame'): string {
  let origin: string | null;
  try {
    origin = new URL(embed.imageUrl).origin;
  } catch {
    origin = null;
  }
  const title =
    embed.buttonTitle.length > 0 && embed.buttonTitle.length <= MINI_APP_BUTTON_TITLE_MAX_V1
      ? embed.buttonTitle
      : MINI_APP_FALLBACK_TITLE_V1;
  return JSON.stringify({
    version: '1',
    imageUrl: embed.imageUrl,
    button: {
      title,
      action: {
        type,
        name: MINI_APP_NAME_V1,
        ...(embed.url ? { url: embed.url } : {}),
        ...(origin
          ? { splashImageUrl: miniAppSplashUrlV1(origin), splashBackgroundColor: MINI_APP_SPLASH_BACKGROUND_V1 }
          : {}),
      },
    },
  });
}
