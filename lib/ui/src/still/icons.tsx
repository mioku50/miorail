import React from 'react';

void React;

// ---------------------------------------------------------------------------
// Line icons for Still's own pages: one stroke weight, drawn in currentColor
// so the page decides their colour. They name places and kinds of things and
// claim nothing; the sun, clouds and coins stay with the sky, which does.
// ---------------------------------------------------------------------------

export type StillIconNameV1 =
  | 'spend'
  | 'swap'
  | 'discover'
  | 'watch'
  | 'today'
  | 'assistant'
  | 'wallet'
  | 'activity'
  | 'settings'
  | 'esim'
  | 'refill'
  | 'giftcard'
  | 'games'
  | 'entertainment'
  | 'ai'
  | 'marketplace'
  | 'food'
  | 'travel'
  | 'info'
  | 'shield';

const PATHS_V1: Record<StillIconNameV1, React.ReactNode> = {
  spend: (
    <>
      <path d="M5.5 8h13l-1.1 11.2a1.5 1.5 0 0 1-1.5 1.3H8.1a1.5 1.5 0 0 1-1.5-1.3z" />
      <path d="M9 10V6.8a3 3 0 0 1 6 0V10" />
    </>
  ),
  swap: <path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5" />,
  discover: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
  watch: (
    <>
      <path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  today: (
    <>
      <rect x="3.5" y="4.5" width="17" height="12.5" rx="2" />
      <path d="M8.5 20.5h7M12 17v3.5" />
    </>
  ),
  assistant: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5z" />
      <path d="M12 6.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none" />
    </>
  ),
  wallet: (
    <>
      <path d="M5 7.5V7a2 2 0 0 1 2-2h10.5" />
      <rect x="3.8" y="7.5" width="16.4" height="11.5" rx="2.5" />
      <path d="M15.5 13.2h2" />
    </>
  ),
  activity: (
    <>
      <path d="M4.2 12a7.8 7.8 0 1 0 2.3-5.5" />
      <path d="M4.2 4.8v3.6h3.6" />
      <path d="M12 8.2V12l2.8 1.8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9.5M18.5 7H20M4 17h3.5M12.5 17H20" />
      <circle cx="16" cy="7" r="2.3" />
      <circle cx="10" cy="17" r="2.3" />
    </>
  ),
  esim: (
    <>
      <path d="M7.5 3h6.8L18.5 7.2V19.5a1.5 1.5 0 0 1-1.5 1.5H7.5A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3z" />
      <rect x="9" y="11" width="6" height="6.5" rx="1" />
      <path d="M12 11v6.5M9 14.2h6" />
    </>
  ),
  refill: (
    <>
      <rect x="7" y="2.8" width="10" height="18.4" rx="2.4" />
      <path d="M11 18h2" />
    </>
  ),
  giftcard: (
    <>
      <rect x="3.5" y="8" width="17" height="4" rx="1" />
      <path d="M5 12v7.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V12M12 8v12.5" />
      <path d="M12 8C10.8 5.2 7.2 4.6 7.2 6.6 7.2 8 9.6 8 12 8zm0 0c1.2-2.8 4.8-3.4 4.8-1.4C16.8 8 14.4 8 12 8z" />
    </>
  ),
  // Gift card categories (Spend, 2026-11-14): what each kind of card is for, nothing about any brand.
  games: (
    <>
      <path d="M7.5 7.5h9a4.5 4.5 0 0 1 4.4 5.4l-.8 4a2.4 2.4 0 0 1-4.2 1l-1.7-2.2h-4.4l-1.7 2.2a2.4 2.4 0 0 1-4.2-1l-.8-4A4.5 4.5 0 0 1 7.5 7.5z" />
      <path d="M8 10.5v3M6.5 12h3" />
      <path d="M15.5 11h.01M17.5 13h.01" strokeWidth="2.4" />
    </>
  ),
  entertainment: (
    <>
      <rect x="3" y="5" width="18" height="12.5" rx="2.5" />
      <path d="M10.2 8.6v5.3l4.4-2.65z" />
      <path d="M8.5 20.5h7" />
    </>
  ),
  ai: (
    <>
      <path d="M10.5 4.5l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4-4.4-1.6 4.4-1.6z" />
      <path d="M17.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>
  ),
  marketplace: (
    <>
      <path d="M3 4h2.2l2.1 10.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6" />
      <circle cx="9.5" cy="19" r="1.4" />
      <circle cx="17" cy="19" r="1.4" />
    </>
  ),
  food: (
    <>
      <path d="M6 3v5.5a2.5 2.5 0 0 0 5 0V3M8.5 3v18" />
      <path d="M17.5 21V3c-2 1.2-3 3.8-3 7.5 0 1.6.9 2.5 3 2.5" />
    </>
  ),
  travel: (
    <path transform="rotate(45 12 12)" d="M12 2.8c.9 0 1.5.9 1.5 2V9.5l6.8 4.1v2l-6.8-2.1v4.6l2.2 1.7v1.6L12 20.3l-3.7 1.1v-1.6l2.2-1.7v-4.6l-6.8 2.1v-2l6.8-4.1V4.8c0-1.1.6-2 1.5-2z" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2" />
      <path d="M12 7.6h.01" strokeWidth="2.6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5.5 6v5.6c0 4.2 2.8 7.4 6.5 8.9 3.7-1.5 6.5-4.7 6.5-8.9V6z" />
      <path d="m9.2 12.1 2 2 3.8-4" />
    </>
  ),
};

export function StillIconV1({ name, className }: { name: StillIconNameV1; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {PATHS_V1[name]}
    </svg>
  );
}
