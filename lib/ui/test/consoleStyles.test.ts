import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const consoleDir = path.join(here, '..', 'src', 'console');
const css = readFileSync(path.join(consoleDir, 'console.css'), 'utf8');

// ---------------------------------------------------------------------------
// Every console class must have a rule.
//
// This exists because the NFT panels shipped with an invented class vocabulary
// — `nft-card`, `nft-row`, `nft-identity` — that no stylesheet ever defined.
// Every unit test passed: the components rendered the right TEXT, in the right
// order, with the right copy. They just had no layout, so a Route Card reached
// production as a wall of run-together words.
//
// Rendering tests assert what a panel SAYS. This asserts that it can be read.
// ---------------------------------------------------------------------------

/** Classes with a rule in console.css. */
const defined = new Set(css.match(/\.[A-Za-z][A-Za-z0-9_-]*/g)?.map((selector) => selector.slice(1)) ?? []);

/**
 * Classes that legitimately come from somewhere else.
 *
 * Kept deliberately tiny and explicit: an allowlist is how this guard would
 * quietly stop working. `mio-console` is the scope root the host applies, and
 * `mini` is the miniapp's modifier on it.
 */
const EXTERNAL_V1 = new Set(['mio-console', 'mini']);

function consoleSources(): { file: string; source: string }[] {
  return readdirSync(consoleDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ file: name, source: readFileSync(path.join(consoleDir, name), 'utf8') }));
}

/** Static class tokens in a file. Interpolations are blanked out first, so
 * `pill ${tone}` contributes `pill` and nothing invented. */
function classTokens(source: string): string[] {
  const tokens: string[] = [];
  const pattern = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    tokens.push(...raw.split(/\s+/).filter(Boolean));
  }
  return tokens;
}

describe('every console class has a stylesheet rule', () => {
  test('no panel invents a class vocabulary nobody styled', () => {
    const orphans: string[] = [];
    for (const { file, source } of consoleSources()) {
      for (const token of new Set(classTokens(source))) {
        if (defined.has(token) || EXTERNAL_V1.has(token)) continue;
        orphans.push(`${file}: .${token}`);
      }
    }
    assert.deepEqual(orphans, [], `these classes render as unstyled text:\n${orphans.join('\n')}`);
  });

  test('the NFT panels reuse the console vocabulary rather than their own', () => {
    const source = readFileSync(path.join(consoleDir, 'NftPanels.tsx'), 'utf8');
    // The panels are built from the same pieces every other panel uses.
    for (const shared of ['panel', 'ph', 'pb', 'qrow', 'cardrow', 'scorerow', 'pill', 'btn']) {
      assert.ok(classTokens(source).includes(shared), `NftPanels must use the shared .${shared}`);
    }
    // Only the image slot is new, because nothing else on the console shows one.
    const own = new Set(classTokens(source).filter((token) => token.startsWith('nft')));
    assert.deepEqual([...own].sort(), ['nftmedia', 'nftmedia-ph', 'nftrow']);
  });

  test('the media placeholder and its hatching are both styled', () => {
    // The blocked-image state is the one a policy-restricted deployment always
    // sees, so it cannot be the unstyled path.
    assert.match(css, /\.nftmedia\.na\s*\{/);
    assert.match(css, /\.nftmedia \.nftmedia-ph\s*\{/);
  });
});
