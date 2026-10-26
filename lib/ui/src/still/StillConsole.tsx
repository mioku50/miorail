import React from 'react';

import type { ConsoleFrameV1Props } from '../console/ConsoleShell';
import type { SkyStateV1 } from './skyState';
import { StillFrame, StillHeader, type StillTabV1 } from './StillFrame';

void React;

// ---------------------------------------------------------------------------
// Miorail's console pages inside Still's frame: Stocks and everything under
// More. The page keeps its own content and styles; the frame gives it Still's
// navigation, a title from its breadcrumb, the sky's palette, and a page that
// scrolls as a page. Its live-data column sits beside it on a wide screen and
// folds under it on a narrow one, as it did in the console.
// ---------------------------------------------------------------------------

export function StillConsolePage({
  tab,
  sky,
  crumb,
  right,
  railFold,
  execution,
  children,
}: ConsoleFrameV1Props & { tab: StillTabV1; sky: SkyStateV1 }) {
  return (
    <StillFrame tab={tab} sky={sky} wide>
      <StillHeader title={crumb[0] ?? ''} trail={crumb.slice(1).join(' · ') || null} sky={sky} />
      <div className={`mio-console still-console${right ? '' : ' no-right'}`}>
        <div className="still-console-body">
          {execution ? (
            <details className="still-execution">
              <summary>Goals and proofs</summary>
              {execution}
            </details>
          ) : null}
          {children}
          {railFold ? <div className="railfold">{railFold}</div> : null}
        </div>
        {right ? <aside className="right" aria-label="Live data">{right}</aside> : null}
      </div>
    </StillFrame>
  );
}
