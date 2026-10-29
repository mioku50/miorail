import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { useStillClientPaletteV1 } from '../../../../lib/ui/src/still/StillFrame';
import { skyStateV1 } from '../../../../lib/ui/src/still/skyState';
import '../../../../lib/ui/src/still/still.css';

void React;
const sky = (at: string) => skyStateV1({ now: new Date(at) });
function Palette({ at }: { at: string }) {
  const palette = useStillClientPaletteV1(sky(at));
  return <main className="still" data-sky={palette}>Still palette</main>;
}

/** A real server render followed by browser hydration. The server and client
 * deliberately observe different times, as with a prerendered Next page. */
export function hydratePalette(serverTime: string, clientTime: string) {
  const container = document.querySelector('#palette-fixture')!;
  container.innerHTML = renderToString(<Palette at={serverTime} />);
  container.setAttribute('data-server-sky', container.firstElementChild!.getAttribute('data-sky')!);
  const root = hydrateRoot(container, <Palette at={clientTime} />);
  return { update: (at: string) => root.render(<Palette at={at} />), unmount: () => root.unmount() };
}

