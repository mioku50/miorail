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

/**
 * The swap comparison call, as written.
 *
 * Scanned by balancing parentheses rather than matched by a regex. The previous
 * pattern assumed the argument object contained no nested braces, so adding a
 * conditional spread to it silently truncated the capture and the assertions
 * below started checking a fragment. A guard that stops seeing what it guards
 * is worse than no guard.
 */
function callSourceV1(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) return '';
  let depth = 0;
  for (let index = start + marker.length - 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
}

const evaluateCall = callSourceV1(source, 'evaluation.mutate(');

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
    // The sentence moved into `comparingTransportFailureV1`, which also reads
    // the code back so a failure of OURS can be named as ours.
    assert.match(source, /comparingTransportFailureV1\(transportError\)/);
  });

  // 2026-09-06 — our own language model answered 429 and this rail drew every
  // adapter "not reached" with 0 sources, which reads as a market with no
  // route. Where the run stopped now decides what the venue rows may claim.
  test('a planner outage is not drawn as a market that was asked', () => {
    assert.match(
      source,
      /terminalStage: transportFailure\?\.stage \?\? 'intent'/,
      'the stage must reach the rail, and default to claiming nothing',
    );
  });
});
