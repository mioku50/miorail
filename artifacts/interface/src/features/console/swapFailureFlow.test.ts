import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'RouteIntelligenceConsole.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// A swap comparison that fails must end where every other family's failure
// ends: on Comparing, naming the reason.
//
// It did not. Swap alone passed `onError: () => setScreen('plan')`, so a 500
// from /swap/evaluate returned the user to the home screen with no message at
// all — the observed symptom was "it searches, compares routers, then throws me
// back to the main screen and that's it". The machinery to report it (a halted
// rail, a terminal failure card, the server's own error text) was already built
// and already used by Earn, NFT, Commerce and AI; swap navigated away from it.
// ---------------------------------------------------------------------------

/** The swap comparison call, as written. */
const evaluateCall = /evaluation\.mutate\(\{[^}]*\}(?:,\s*\{[\s\S]*?\})?\s*\)/.exec(source)?.[0] ?? '';

describe('a failed swap comparison is reported, not navigated away from', () => {
  test('the swap comparison is present to be checked', () => {
    assert.notEqual(evaluateCall, '', 'evaluation.mutate must be present');
  });

  test('no family sends a failed comparison back to the Plan screen', () => {
    // The guarantee is about the whole file, not just the swap call: adding this
    // handler to any other family would reintroduce the same silent dead end.
    assert.ok(
      !/onError:\s*\(\)\s*=>\s*setScreen\('plan'\)/.test(source),
      'a comparison failure must never navigate to Plan — the reason is lost with the screen',
    );
  });

  test('a settled swap comparison stops the rail, however it settled', () => {
    // On success the projection effect also completes this stage; completeStageV1
    // is idempotent, so the earlier mark wins. On failure this is the ONLY thing
    // that stops "Comparing routes" from spinning forever.
    assert.match(
      evaluateCall,
      /onSettled:\s*\(\)\s*=>\s*mark\('candidates',\s*'complete'\)/,
      'the swap comparison must complete its stage on settle',
    );
  });

  test('the swap transport error reaches the terminal failure card', () => {
    assert.match(source, /const transportError = \(evaluation\.error/, 'evaluation.error must feed transportFailure');
    assert.match(source, /transportFailure \?\?/, 'transportFailure must be one of the comparingFailure sources');
    assert.match(
      source,
      /failure=\{comparingFailure\}/,
      'Comparing must render the failure rather than leave a blank rail',
    );
  });

  test('a terminal failure halts the stage rail instead of leaving it spinning', () => {
    assert.match(source, /steps=\{comparingFailure \? haltStageRailV1\(steps\) : steps\}/);
  });

  test('the failure names the server, and says nothing was spent', () => {
    // "The server did not answer" gave the operator nothing to act on. The
    // server's own code — route_plan_evaluation_failed — points at one log line.
    assert.match(source, /\$\{transportError\.message\} Nothing was signed or spent\./);
  });
});
