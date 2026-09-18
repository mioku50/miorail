import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PublicIdentityCheck } from '../src/PublicIdentityCheck';

void React;

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('the public identity page', () => {
  test('opens with the question and the input, and asks for nothing else', () => {
    const html = renderToStaticMarkup(<PublicIdentityCheck />);
    assert.match(html, /Is this the real one\?/);
    assert.match(html, /Contract address/);
    // No session, no wallet, no connect. The reader has none of those.
    assert.doesNotMatch(html, /connect|sign in|wallet/i);
    // And it says where the answer comes from before it gives one.
    assert.match(html, /Nothing is read from\s+the chain for this check/);
  });

  test('a linkable address is checked on arrival rather than waiting for a click', () => {
    // Somebody was SENT this link by a person who already had the address.
    // Making them press a button again would be asking them to retype a fact
    // that is already in the URL.
    const source = read('lib/ui/src/PublicIdentityCheck.tsx');
    assert.match(source, /useEffect\(\(\) => \{\s*if \(props\.tokenAddress/);
    assert.match(source, /void check\(props\.tokenAddress\)/);
  });

  test('the component never renders a tone the stylesheet cannot paint', () => {
    // console.css owns the tone vocabulary. A tone it has no rule for renders
    // as an unstyled chip, which reads as a missing verdict rather than a
    // present one.
    const css = read('lib/ui/src/console/console.css');
    for (const tone of ['good', 'warn', 'neutral', 'off']) {
      assert.ok(
        css.includes(`data-tone='${tone}'`) || css.includes(`data-tone="${tone}"`),
        `console.css has no rule for data-tone ${tone}`,
      );
    }
  });

  test('the page styles live in console.css, not in Tailwind classes', () => {
    // Neither build generates Tailwind for these components, so a Tailwind
    // class here is an unstyled element that still looks intentional in JSX.
    const source = read('lib/ui/src/PublicIdentityCheck.tsx');
    const classes = [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) =>
      match[1]!.split(/\s+/),
    );
    const tailwindish = classes.filter((name) =>
      /^(?:flex|grid-cols|gap-\d|p[xytblr]?-\d|m[xytblr]?-\d|text-(?:xs|sm|base|lg|xl)|bg-|rounded-|font-(?:bold|semibold)|w-full|items-|justify-)/.test(
        name,
      ),
    );
    assert.deepEqual(tailwindish, []);
    const css = read('lib/ui/src/console/console.css');
    for (const name of classes.filter((entry) => entry.startsWith('pi-'))) {
      assert.ok(css.includes(`.${name}`), `console.css has no rule for .${name}`);
    }
  });
});
