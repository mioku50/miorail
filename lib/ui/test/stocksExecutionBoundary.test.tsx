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

describe('the Stocks screen cannot execute anything', () => {
  const screen = read('lib/ui/src/console/MarketRealityScreen.tsx');
  const page = read('artifacts/interface/src/features/rwa/MarketRealityPage.tsx');

  // §11.9, §11.10, §3
  test('neither the screen nor its page can build a call, sign, or submit', () => {
    for (const [label, source] of [
      ['MarketRealityScreen', screen],
      ['MarketRealityPage', page],
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
  test('the page hands over an address and never a ticker', () => {
    assert.ok(page.includes('stockExecutionHandoffV1'), 'the page builds the reviewed handoff');
    assert.ok(
      page.includes('stockExecutionGoalSentenceV1'),
      'the page uses the address-only sentence',
    );
    // The navigation carries the built sentence, not a label from the view.
    assert.ok(!/goal:\s*`[^`]*\$\{[^}]*(symbol|Symbol|title|name)/.test(page));
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
