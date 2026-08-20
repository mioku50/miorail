import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const uiRoot = path.join(here, '..');
const repoRoot = path.join(uiRoot, '..', '..');
const css = readFileSync(path.join(uiRoot, 'src/console/console.css'), 'utf8');
const web = readFileSync(
  path.join(repoRoot, 'artifacts/interface/src/features/extensions/ExtensionsPage.tsx'),
  'utf8',
);
const mini = readFileSync(
  path.join(repoRoot, 'artifacts/miniapp/app/components/MiniConsole.tsx'),
  'utf8',
);

describe('plugin examples fill and focus the same console on both surfaces', () => {
  for (const [surface, source, start, setter] of [
    ['desktop/BaseApp', web, 'onSelectPrompt: (prompt', 'setQuestion(prompt)'],
    ['MiniApp', mini, 'onSelectPrompt={(prompt', 'setBaseMcpQuestion(prompt)'],
  ] as const) {
    test(surface, () => {
      const selection = source.slice(source.indexOf(start));
      assert.match(selection, new RegExp(setter.replace(/[()]/g, '\\$&')));
      assert.match(selection, /BASE_MCP_CONSOLE_INPUT_ID_V1/);
      assert.match(selection, /scrollIntoView/);
      assert.match(selection, /\.focus\(\{ preventScroll: true \}\)/);

      // The catalogue callback owns only the input value and focus. Execution
      // remains under the explicit Ask button's separate onAsk handler.
      const callback = selection.slice(0, 700);
      assert.doesNotMatch(callback, /\.mutate\(|onAsk/);
    });
  }
});

test('MiniApp keeps the console before the explorer, matching the web surface', () => {
  const extensionBranch = mini.slice(mini.indexOf('section === "extensions"'));
  assert.ok(extensionBranch.indexOf('<BaseMcpConsoleCard') < extensionBranch.indexOf('<BaseMcpPluginsCard'));
  assert.ok(web.indexOf('<BaseMcpConsoleCard') < web.indexOf('<BaseMcpPluginsCard'));
});

describe('desktop and BaseApp/mobile expose the promised number of examples', () => {
  test('desktop keeps the second example visible and offers More examples', () => {
    assert.match(css, /\.mcp-desktop-second/);
    assert.match(css, /\.mcp-more-desktop/);
    assert.match(css, /\.mcp-more\.two-only\s*\{\s*display:\s*none/);
  });

  test('mobile hides the second direct prompt and exposes Examples (N)', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));
    assert.match(mobile, /\.mcp-desktop-second[^}]*display:\s*none/);
    assert.match(mobile, /\.mcp-more-mobile[^}]*display:\s*initial/);
    assert.match(mobile, /\.mcp-example\.mcp-mobile-second[^}]*display:\s*grid/);
    assert.match(mobile, /\.mcp-plugin-grid[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  });
});
