// ---------------------------------------------------------------------------
// Phones draw every page at three quarters of its CSS size (operator,
// 2026-11-03): the size Safari showed at 75% page zoom is the one wanted, in
// Farcaster and Base App too, where pages drew a third larger. index.html
// asks for it, so it holds from the first paint. The browser zooms out and
// lays the page out in the wider viewport that implies (393 points lay out
// 524 pixels), so units, fixed bars and safe areas stay the browser's own.
// The maximum keeps iOS from zooming into a focused field, which it does for
// text drawn under 16 pixels; Safari still lets a person pinch. A tablet
// keeps the size it is made for.
// ---------------------------------------------------------------------------

export const PHONE_VIEWPORT_V1 = 'width=device-width, initial-scale=0.75, maximum-scale=0.75';
export const TABLET_VIEWPORT_V1 = 'width=device-width, initial-scale=1.0';

/** The viewport for a screen of this size, its sides in CSS pixels at scale 1. */
export function viewportForScreenV1(screen: { width: number; height: number }): string {
  return Math.min(screen.width, screen.height) >= 600 ? TABLET_VIEWPORT_V1 : PHONE_VIEWPORT_V1;
}
