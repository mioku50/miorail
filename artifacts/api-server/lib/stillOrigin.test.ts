import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { STILL_PUBLIC_ORIGIN_V1 } from './stillOrigin.js';

function repoFileV1(relative: string): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${path.sep}artifacts${path.sep}api-server`)
    ? path.join(cwd, '../..', relative)
    : path.join(cwd, relative);
}

// A share link made here and the page's own share row, or a chat card's review
// and the image its link previews with, must not send people to two doors.
test('the API, the pages and the preview image send people to one host', () => {
  const pages = readFileSync(repoFileV1('lib/ui/src/stillOrigin.ts'), 'utf8');
  assert.ok(pages.includes(`export const STILL_PUBLIC_ORIGIN_V1 = '${STILL_PUBLIC_ORIGIN_V1}';`));
  const html = readFileSync(repoFileV1('artifacts/interface/index.html'), 'utf8');
  for (const tag of ['property="og:image"', 'name="twitter:image"']) {
    assert.ok(html.includes(`<meta ${tag} content="${STILL_PUBLIC_ORIGIN_V1}/og-still.png" />`), tag);
  }
});
