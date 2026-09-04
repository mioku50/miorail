import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------------------
// Phase 13.1 §8/§10/§11 — the boundary, checked where it can actually break.
//
// The handoff contract is unit-tested in rwa-market-reality. What is checked
// here is the thing a contract cannot hold: that the SCREEN does not reach
// past it, and that the reviewed execution sequence behind it is unchanged.
// ---------------------------------------------------------------------------

describe('Phase 17.4 — the primary action is prepare, and it is still only prepare', () => {
  const screen = read('lib/ui/src/console/MarketRealityScreen.tsx');

  test('the card offers both sides without re-asking the board', () => {
    // The measurement used to end at a number, with the only way through named
    // `Advanced: inspect route` — third in the action row, on another surface.
    //
    // Asserted against the RENDERED text rather than the file, because the
    // comment above the new buttons quotes the old label to say what it
    // replaced, and a file-wide search cannot tell a label from its own history.
    const rendered = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(rendered, /Prepare buy/);
    assert.match(rendered, /Prepare sell/);
    assert.doesNotMatch(rendered, /Advanced: inspect route/);
  });

  test('the buttons say what they do not do', () => {
    // A primary button on a financial card has to state its own boundary where
    // the finger is, not in a paragraph elsewhere on the page.
    const titles = [...screen.matchAll(/title="([^"]*prepare step[^"]*)"/g)].map((m) => m[1]);
    assert.ok(titles.length >= 2, 'the prepare buttons carry no boundary text');
    for (const title of titles) {
      assert.match(title!, /Nothing is approved, submitted, or signed here/);
    }
  });

  test('the route inspector is kept, demoted, and its refusal is still stated', () => {
    // Nothing is removed: a reader who wants the candidate list rather than a
    // plan still has it, and a refusal is a sentence rather than a dead chip.
    assert.match(screen, /Inspect route candidates/);
    assert.match(screen, /inspectRouteUnavailable/);
  });
});

describe('the Stocks screen cannot execute anything', () => {
  const screen = read('lib/ui/src/console/MarketRealityScreen.tsx');
  const page = read('artifacts/interface/src/features/rwa/MarketRealityPage.tsx');
  // Phase 15.1 — the reads and the handoff moved out of the page and into the
  // console both surfaces mount. The boundary did not move; its home did.
  const console_ = read('lib/ui/src/console/stocksConsole.ts');
  const miniapp = read('artifacts/miniapp/app/components/MiniConsole.tsx');

  // §11.9, §11.10, §3
  test('neither the screen nor its page can build a call, sign, or submit', () => {
    for (const [label, source] of [
      ['MarketRealityScreen', screen],
      ['MarketRealityPage', page],
      ['stocksConsole', console_],
    ] as const) {
      for (const forbidden of [
        'wallet_sendCalls',
        'useSendCalls',
        'sendTransaction',
        'signTypedData',
        'signMessage',
        'useSubmitApprovedBlueprint',
        'usePrepareSwapBlueprint',
        'useApproveSwapBlueprint',
        'useRecordBlueprintSubmission',
        'useEvaluateSwapRoute',
        'calldata',
        'encodeFunctionData',
      ]) {
        assert.ok(
          !source.includes(forbidden),
          `${label} must not reference ${forbidden} — Stocks is analysis`,
        );
      }
    }
  });

  // §10 — the execution-first furniture stays out of Stocks.
  test('no execution session, proof panel or New Goal sidebar returns to Stocks', () => {
    for (const forbidden of ['RouteProofPanel', 'New Goal', 'BlueprintSubmitButton', 'ProofScreen']) {
      assert.ok(!screen.includes(forbidden), `Stocks must not render ${forbidden}`);
      assert.ok(!page.includes(forbidden), `the Stocks page must not render ${forbidden}`);
    }
  });

  // §2 — the handoff is built from the typed answer, by address.
  test('the console hands over an address and never a ticker', () => {
    assert.ok(
      console_.includes('stockExecutionHandoffV1'),
      'the shared console builds the reviewed handoff',
    );
    assert.ok(
      console_.includes('stockExecutionGoalSentenceV1'),
      'the shared console uses the address-only sentence',
    );
    // The navigation carries the built sentence, not a label from the view.
    assert.ok(!/goal:\s*`[^`]*\$\{[^}]*(symbol|Symbol|title|name)/.test(page));
    assert.ok(!/goal:\s*`[^`]*\$\{[^}]*(symbol|Symbol|title|name)/.test(console_));
  });

  test('the Base App mounts Stocks with no advanced route surface at all', () => {
    // Absent, not inert: the Base App passes no `onInspectRoute`, so the shared
    // console omits the action rather than rendering a control that refuses.
    // A per-address REFUSAL is a different thing and still reaches the screen.
    assert.ok(miniapp.includes('useStocksConsoleV1'), 'the Base App mounts the shared console');
    assert.ok(!/onInspectRoute:/.test(miniapp), 'and hands it no advanced route callback');
  });

  // §3 — opening advanced execution is not approval.
  test('the advanced action navigates and submits nothing', () => {
    const block = page.slice(page.indexOf('onInspectRoute'));
    const body = block.slice(0, block.indexOf('},\n'));
    assert.ok(body.includes('navigate('), 'it navigates');
    assert.ok(!body.includes('mutate('), 'it must not fire a mutation');
    assert.ok(!body.includes('approve'), 'it must not approve');
  });
});

describe('the reviewed execution sequence is unchanged', () => {
  const routes = read('artifacts/api-server/routes/routeIntelligence.ts');

  // §8, §11.13
  test('every stage of the reviewed path is still mounted, in order', () => {
    const stages = [
      "post('/swap/evaluate'",
      "post('/swap/prepare'",
      "post('/swap/blueprints/:blueprintId/approve'",
      "post('/swap/blueprints/:blueprintId/submission'",
      "post('/route-proofs/:proofId/reconcile'",
      "get('/route-proofs/:proofId'",
    ];
    let cursor = 0;
    for (const stage of stages) {
      const at = routes.indexOf(stage, cursor);
      assert.ok(at > 0, `${stage} must still be mounted`);
      cursor = at;
    }
  });

  // §11.13 — the kernel runs on the STORED blueprint at approval, not only at
  // prepare, so a blueprint cannot be approved on a stale verdict.
  test('the Safety Kernel still runs at approval as well as at planning', () => {
    const approval = read('lib/transaction-composer/src/approval.ts');
    const coordinator = read('lib/transaction-composer/src/coordinator.ts');
    assert.ok(approval.includes('runSafetyKernel('), 'approval re-runs the kernel');
    assert.ok(coordinator.includes('runSafetyKernel('), 'planning runs the kernel');
  });

  // §11.10 — the server never signs or broadcasts.
  test('no server-side signer or broadcast exists on the execution path', () => {
    for (const rel of [
      'artifacts/api-server/routes/routeIntelligence.ts',
      'lib/transaction-composer/src/approval.ts',
      'lib/transaction-composer/src/coordinator.ts',
    ]) {
      const source = read(rel);
      for (const forbidden of ['signTransaction', 'sendRawTransaction', 'privateKey', 'PRIVATE_KEY']) {
        assert.ok(!source.includes(forbidden), `${rel} must not contain ${forbidden}`);
      }
    }
  });
});

describe('the market/infrastructure taxonomy survives the boundary', () => {
  // §7, §11.11, §11.12 — the words the handoff surface may show are the ones
  // the accepted taxonomy already defines. None of them says untradeable.
  const view = read('lib/ui/src/console/marketRealityView.ts');

  test('no outcome collapses into "cannot be traded"', () => {
    // Comments are excluded on purpose: the file explains at length WHY it must
    // not say this, and matching the explanation would fail the rule it states.
    const copy = view
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(copy, /cannot be traded|untradeable|not tradable/i);
  });

  test('provider failure and reviewed no-route remain separate outcomes', () => {
    for (const outcome of ['provider_failed', 'unsupported_token', 'no_route', 'unsized']) {
      assert.ok(view.includes(`'${outcome}'`), `${outcome} must remain a distinct outcome`);
    }
  });
});

describe('the manual launch check stays a read', () => {
  // Phase 15.1. The authenticated smoke needs a signed wallet session, so a
  // human runs it in their own browser. That makes it the one script in the
  // repo a person is invited to paste into a page holding their session — so
  // what it may do is pinned here rather than left to review.
  const smoke = read('scripts/manual-phase15-auth-smoke.js');

  test('it cannot sign, submit or approve anything', () => {
    for (const forbidden of [
      'wallet_sendCalls',
      'eth_sendTransaction',
      'signTransaction',
      'personal_sign',
      'signTypedData',
      'window.ethereum',
      'calldata',
      '/execute',
      '/order/complete',
      '/swap/prepare',
      '/blueprint',
    ]) {
      assert.ok(!smoke.includes(forbidden), `the manual smoke must not contain ${forbidden}`);
    }
  });

  test('every write it makes is a Radar watch it also removes', () => {
    const writes = [...smoke.matchAll(/method:\s*['"](POST|DELETE|PUT|PATCH)['"]/g)].map(
      (match) => match[1]!,
    );
    // Three Ask calls and one watch add are the POSTs; the DELETE undoes the
    // add. Anything else is a write this check is not allowed to make.
    // One helper issues every POST (the three Asks and the watch add) and the
    // removal is the one DELETE. Any other write verb is one this check may
    // not make.
    assert.deepEqual([...new Set(writes)].sort(), ['DELETE', 'POST']);
    assert.ok(smoke.includes('/radar/watches'), 'the watch it adds');
    // The removal names the same collection; the URL is written before the
    // verb, so the window is checked in both directions.
    assert.ok(
      /radar\/watches[\s\S]{0,300}DELETE/.test(smoke),
      'and the one it removes',
    );
  });
});
