import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

// ---------------------------------------------------------------------------
// SVG to PNG, for the images a shared link previews as.
//
// X and Telegram take PNG, not SVG. resvg runs as WebAssembly, so nothing
// native is installed and nothing it is handed can reach the process. It is
// handed only SVG this server wrote.
//
// It draws with the four font files in assets/fonts (Inter and JetBrains Mono,
// the board's own faces, under the SIL Open Font License) and never with the
// machine's fonts. The picture is the same on the server as in a test.
// ---------------------------------------------------------------------------

const FONT_FILES_V1 = [
  'Inter-Regular.ttf',
  'Inter-SemiBold.ttf',
  'JetBrainsMono-Regular.ttf',
  'JetBrainsMono-SemiBold.ttf',
] as const;

const FONT_DIRECTORY_V1 = path.resolve(__dirname, '../assets/fonts');

/** The module can be initialised once per process, so a success is kept for
 * good and a failure is forgotten, to be tried again on the next picture. */
let wasmReadyV1: Promise<void> | null = null;
let fontsV1: Promise<Uint8Array[]> | null = null;

function readyV1(): Promise<Uint8Array[]> {
  if (!wasmReadyV1) {
    const ready = readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')).then((wasm) => initWasm(wasm));
    wasmReadyV1 = ready;
    ready.catch(() => {
      if (wasmReadyV1 === ready) wasmReadyV1 = null;
    });
  }
  if (!fontsV1) {
    const fonts = Promise.all(
      FONT_FILES_V1.map(async (name) => new Uint8Array(await readFile(path.join(FONT_DIRECTORY_V1, name)))),
    );
    fontsV1 = fonts;
    fonts.catch(() => {
      if (fontsV1 === fonts) fontsV1 = null;
    });
  }
  const wasm = wasmReadyV1;
  return wasm.then(() => fontsV1!);
}

export async function renderCardPngV1(svg: string): Promise<Uint8Array> {
  const fontBuffers = await readyV1();
  const resvg = new Resvg(svg, {
    font: { fontBuffers, defaultFontFamily: 'Inter', sansSerifFamily: 'Inter', monospaceFamily: 'JetBrains Mono' },
    fitTo: { mode: 'original' },
  });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
