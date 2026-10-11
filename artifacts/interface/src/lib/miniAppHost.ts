import type { ShareHostV1 } from '@mioagent/ui';

// ---------------------------------------------------------------------------
// Is this page running as a Farcaster mini app?
//
// Farcaster opens a mini app in its own webview (a React Native WebView on a
// phone, an iframe on the web) and speaks to it through
// @farcaster/miniapp-sdk. Three things then differ from a browser:
//   1. Farcaster shows its splash screen until the page says it is ready;
//   2. a cast is composed by Farcaster itself: farcaster.xyz/~/compose is a web
//      page that, inside the app, asks you to download the app (the operator,
//      2026-10-11);
//   3. the wallet is the one Farcaster announces (EIP-6963), and a Base
//      Account popup has nowhere to open.
//
// The SDK is loaded only inside such a frame, so a browser never downloads it.
// Base App runs pages in a webview too, but it treats every app as a standard
// web app since 2026-04-09, so main.tsx never asks there.
// ---------------------------------------------------------------------------

export interface MiniAppFrameProbeV1 {
  /** A React Native WebView: how Farcaster's phone app hosts a page. */
  reactNativeWebView: boolean;
  /** Inside another page's frame: how Farcaster on the web hosts one. */
  framed: boolean;
}

export function miniAppFrameProbeV1(win: Window): MiniAppFrameProbeV1 {
  let framed: boolean;
  try {
    framed = win.self !== win.top;
  } catch {
    // A cross-origin parent cannot even be compared: that is a frame.
    framed = true;
  }
  return { reactNativeWebView: Boolean((win as { ReactNativeWebView?: unknown }).ReactNativeWebView), framed };
}

/** Only a frame can be a mini app; a top-level browser tab never is. */
export function mayBeMiniAppFrameV1(probe: MiniAppFrameProbeV1): boolean {
  return probe.reactNativeWebView || probe.framed;
}

/** Farcaster takes zero, one or two embeds, as a tuple. */
export function castEmbedsV1(embeds: readonly string[]): [] | [string] | [string, string] {
  if (embeds.length >= 2) return [embeds[0]!, embeds[1]!];
  if (embeds.length === 1) return [embeds[0]!];
  return [];
}

export interface FarcasterHostV1 {
  share: ShareHostV1;
  /** Hides Farcaster's splash screen. */
  ready(): void;
}

let currentV1: FarcasterHostV1 | null = null;

/** The host this page was found in at start, or null in a browser. */
export function farcasterHostV1(): FarcasterHostV1 | null {
  return currentV1;
}

/**
 * Asks once, at start. The SDK waits at most 100 ms for Farcaster to answer
 * and then says no, so a frame that is not Farcaster costs that and no more.
 * Loading the SDK before the wallet config exists also lets it relay
 * Farcaster's EIP-6963 wallet announcement to wagmi's discovery.
 */
export async function detectFarcasterHostV1(win: Window): Promise<FarcasterHostV1 | null> {
  if (!mayBeMiniAppFrameV1(miniAppFrameProbeV1(win))) return null;
  try {
    const { sdk } = await import('@farcaster/miniapp-sdk');
    if (!(await sdk.isInMiniApp())) return null;
    currentV1 = {
      share: {
        composeCast: async (cast) => {
          await sdk.actions.composeCast({ text: cast.text, embeds: castEmbedsV1(cast.embeds) });
        },
        openUrl: (url) => sdk.actions.openUrl(url),
      },
      ready: () => {
        void sdk.actions.ready().catch(() => undefined);
      },
    };
    return currentV1;
  } catch {
    // An SDK that cannot load or answer leaves the page a browser page.
    return null;
  }
}
