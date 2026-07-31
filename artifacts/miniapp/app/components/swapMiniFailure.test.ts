import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'MiniConsole.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// The miniapp had the same defect as the web console, in the same one line:
// only the swap family passed `onError: () => setScreen("plan")`, so a failed
// /swap/evaluate returned the user to the home screen with no message. This is
// the surface the reported failure was seen on — Miorail opened inside Base App.
// ---------------------------------------------------------------------------

const evaluateCall = /evaluation\.mutate\(\{[^}]*\}(?:,\s*\{[\s\S]*?\})?\s*\)/.exec(source)?.[0] ?? '';

describe('a failed swap comparison stays on Comparing in the miniapp', () => {
  test('the swap comparison is present to be checked', () => {
    assert.notEqual(evaluateCall, '', 'evaluation.mutate must be present');
  });

  test('no comparison failure navigates back to Plan on its own', () => {
    assert.ok(
      !/onError:\s*\(\)\s*=>\s*setScreen\("plan"\)/.test(source),
      'the reason is lost with the screen — the user must choose to go back',
    );
  });

  test('a settled swap comparison stops the rail, however it settled', () => {
    assert.match(
      evaluateCall,
      /onSettled:\s*\(\)\s*=>\s*mark\("candidates",\s*"complete"\)/,
      'the swap comparison must complete its stage on settle',
    );
  });

  test('the failure card names the reason and offers the way back', () => {
    assert.match(source, /const transportError = \(evaluation\.error/);
    assert.match(source, /\$\{transportError\.message\} Nothing was signed or spent\./);
    // The user leaves Comparing by choosing to, having read why.
    assert.match(source, /comparingFailure && \(/);
    assert.match(source, /Edit goal/);
  });
});
