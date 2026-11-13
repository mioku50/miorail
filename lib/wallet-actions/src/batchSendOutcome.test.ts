import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as classifiers from '../../ui/src/console/walletBatchSupport';

// ---------------------------------------------------------------------------
// Audit N13-1 (2026-11-13). The batch path read a wallet's error by its words:
// "connection closed" counted as the person's No. The attempt was closed, the
// recovery marker removed, and the next press handed the same calls to the
// wallet again, while the page said the first had been cancelled in the
// wallet. A closed connection or a timeout may arrive after the wallet sent
// the batch, its answer lost on the way back, so it proves nothing.
//
// The hook itself runs here, transpiled, with the wallet, the API and React
// replaced by small doubles, and the REAL classifiers deciding what an error
// means. Each press is a fresh render, as on the page.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const A = `0x${'a'.repeat(40)}`;

interface Harness {
  press(): Promise<{ status: string; error: string | null }>;
  walletAsked: number;
  attemptsOpened: number;
  attemptOpen: boolean;
  markersCleared: number;
  records: string[];
}

function harness(walletAnswers: Array<() => unknown>, goal: 'swap' | 'earn' | 'nft' = 'swap'): Harness {
  const state = { walletAsked: 0, attemptsOpened: 0, attemptOpen: false, markersCleared: 0, records: [] as string[] };
  const cells: unknown[] = [];
  let cursor = 0;
  const react = {
    useState(init: unknown) {
      const at = cursor++;
      if (!(at in cells)) cells[at] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [cells[at], (value: unknown) => {
        cells[at] = typeof value === 'function' ? (value as (v: unknown) => unknown)(cells[at]) : value;
      }];
    },
    useRef(init: unknown) {
      const at = cursor++;
      if (!(at in cells)) cells[at] = { current: init };
      return cells[at];
    },
    useCallback: (fn: unknown) => fn,
    createElement: (type: unknown, props: unknown) => ({ type, props }),
  };
  const payload = {
    from: A, chainId: '0x2105', atomicRequired: true, approvedCallsHash: `0x${'1'.repeat(64)}`,
    calls: [{ to: `0x${'1'.repeat(40)}`, data: '0x1234', value: '0x0' }],
  };
  const approve = () => ({ mutateAsync: async () => ({ outcome: 'approved', payload }) });
  const record = () => ({
    mutateAsync: async (input: { status: string }) => {
      state.records.push(input.status);
      // The server closes the attempt on a cancelled or failed record (recordAttemptOutcomeV1).
      if (input.status === 'cancelled' || input.status === 'failed') state.attemptOpen = false;
      return { proofId: 'proof-1', finalStatus: 'pending' };
    },
  });
  const api = {
    useApproveEarnBlueprint: approve, useApproveSwapBlueprint: approve, useNftApprove: approve,
    useRecordBlueprintSubmission: record, useRecordEarnBlueprintSubmission: record, useRecordNftBlueprintSubmission: record,
    useBindSubmissionBatch: () => ({ mutateAsync: async () => ({}) }),
    useCreateSubmissionAttempt: () => ({
      mutateAsync: async () => {
        // The server's own rule: one open attempt per blueprint.
        if (state.attemptOpen) throw new Error('submission_attempt_open');
        state.attemptOpen = true;
        state.attemptsOpened += 1;
        return { attempt: { id: `attempt-${state.attemptsOpened}`, proofId: null } };
      },
    }),
  };
  const requires: Record<string, unknown> = {
    react,
    wagmi: {
      useAccount: () => ({ address: A, chainId: 8453 }),
      useConfig: () => ({}),
      useSendCalls: () => ({
        mutateAsync: async () => {
          const answer = walletAnswers[state.walletAsked] ?? (() => ({ id: 'batch-ok' }));
          state.walletAsked += 1;
          return answer();
        },
      }),
    },
    'wagmi/actions': {}, 'wagmi/chains': { base: { id: 8453 } }, viem: {},
    '@mioagent/api-client-react': api,
    './attribution': { builderCodeToDataSuffix: () => undefined, attributedCallsV1: (input: { calls: unknown }) => input.calls,
      builderAttributionOutcomeV1: () => ({ status: 'unavailable' }) },
    './useWalletConfirmAction': { normalizeCall: (call: unknown) => call, CallsStatusPoller: () => null },
    './sponsoredGas': { sponsoredGasPlanV1: () => ({ state: 'not_offered', capability: null }) },
    './gasLimitOverride': { gasLimitedCallsV1: async (input: { calls: unknown }) => ({ calls: input.calls, limits: null }), publicGasMeterV1: () => ({}) },
    './walletBatchSupport': {
      ...classifiers,
      sendRetryingWalletNetworkV1: (send: () => unknown) => send(),
      useWalletBatchSupportV1: () => ({ answered: true, capabilities: {}, knownNotToBatch: false, blocker: null, walletName: 'Wallet',
        remember: () => undefined, readNow: async () => ({ capabilities: {} }) }),
    },
    './liveWalletConnection': { requireLiveWalletAccountV1: async () => ({ restored: false }) },
    './sequentialDelivery': {
      swapDeliveryPlanV1: () => 'atomic', batchFailureInvitesStepsV1: (cause: unknown) => classifiers.walletCannotSendSentenceV1(cause) !== null,
      batchRefusalContinuesInStepsV1: () => false, sequentialAfterBatchFailureV1: () => 'steps next',
    },
    './recoveryMarker': { browserMarkerStorageV1: () => ({}), writeRecoveryMarkerV1: () => undefined,
      clearRecoveryMarkerV1: () => { state.markersCleared += 1; } },
  };
  const source = readFileSync(path.join(here, 'useSubmitApprovedBlueprint.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(js, {
    exports: mod.exports, module: mod, console, Error, Promise, Date, Map, Set, JSON, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name in requires) return requires[name];
      throw new Error(`unexpected import ${name}`);
    },
  });
  const hook = mod.exports.useSubmitApprovedBlueprint as (args: Record<string, unknown>) => {
    submit(): Promise<void>; status: string; error: string | null;
  };
  const render = () => {
    cursor = 0;
    return hook({ routeRunId: 'run-1', blueprintId: 'blueprint-1', blueprintHash: `0x${'2'.repeat(64)}`, recovery: true, goal });
  };
  return Object.assign(state, {
    async press() {
      await render().submit();
      const after = render();
      return { status: after.status, error: after.error };
    },
  }) as unknown as Harness;
}

test('a closed connection after the wallet was asked keeps the attempt open and asks no wallet again (audit N13-1)', async () => {
  const run = harness([() => { throw new Error('connection closed'); }]);
  const first = await run.press();
  assert.equal(first.status, 'submitted_unknown');
  assert.match(first.error ?? '', /its answer never came back\. Check your wallet’s activity before anything else/);
  assert.doesNotMatch(first.error ?? '', /Cancelled/);
  assert.equal(run.attemptOpen, true, 'the attempt is not closed on a guess');
  assert.equal(run.markersCleared, 0, 'the recovery marker stays for a reload');
  assert.deepEqual(run.records, [], 'nothing is recorded as cancelled or failed');

  const second = await run.press();
  assert.equal(run.walletAsked, 1, 'the wallet is not asked for the same calls again');
  assert.equal(run.attemptsOpened, 1);
  assert.equal(second.status, 'submitted_unknown');
  assert.match(second.error ?? '', /not asked again/);
});

test('a timeout and a relay error are read the same way: nothing proves the batch did not go out', async () => {
  for (const error of [new Error('Request timed out'), Object.assign(new Error('WebSocket connection closed abnormally'), { code: 1006 }),
    Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 })]) {
    const run = harness([() => { throw error; }]);
    const first = await run.press();
    assert.equal(first.status, 'submitted_unknown', error.message);
    assert.equal(run.attemptOpen, true, error.message);
  }
});

test('the person’s own No in the wallet still closes the attempt, and the next press asks again', async () => {
  const refusal = Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError', code: 4001 });
  const run = harness([() => { throw refusal; }]);
  const first = await run.press();
  assert.equal(first.status, 'cancelled');
  assert.equal(first.error, 'Cancelled in wallet');
  assert.equal(run.attemptOpen, false);
  assert.equal(run.markersCleared, 1);
  assert.deepEqual(run.records, ['cancelled']);
  const second = await run.press();
  assert.equal(run.walletAsked, 2, 'a refusal the wallet names frees the same calls for one more press');
  assert.equal(second.status, 'submitted');
});

test('a popup closed by the person is a No only when the wallet says so by its code', async () => {
  // Base Account rejects every open request with 4001 "Request rejected" when its popup unloads.
  const closedPopup = Object.assign(new Error('Request rejected'), { code: 4001 });
  const run = harness([() => { throw closedPopup; }]);
  assert.equal((await run.press()).status, 'cancelled');
  // The same words without the code are not the person's answer.
  const words = harness([() => { throw new Error('Popup closed by user'); }]);
  assert.equal((await words.press()).status, 'submitted_unknown');
});

test('a wallet that says it cannot send a batch is still a plain failure, free to press again', async () => {
  const cannot = Object.assign(new Error('Method not found'), { code: -32601 });
  const run = harness([() => { throw cannot; }]);
  const first = await run.press();
  assert.equal(first.status, 'failed');
  assert.equal(run.attemptOpen, false);
  assert.deepEqual(run.records, ['failed']);
});

// Audit WAL-1 (2026-11-14): an Earn deposit and an NFT purchase opened no recovery attempt, so a lost answer
// left nothing on record and the same deposit went to the wallet again. The button now asks for one for every
// goal, and the hook holds them exactly as it holds a swap.
test('an Earn deposit and an NFT purchase whose answer never came back are held as a swap is (audit WAL-1)', async () => {
  for (const goal of ['earn', 'nft'] as const) {
    const run = harness([() => { throw new Error('connection closed'); }], goal);
    const first = await run.press();
    assert.equal(first.status, 'submitted_unknown', goal);
    assert.equal(run.attemptOpen, true, goal);
    assert.deepEqual(run.records, [], goal);
    await run.press();
    assert.equal(run.walletAsked, 1, `${goal}: the wallet is not asked for the same calls again`);
    assert.equal(run.attemptsOpened, 1, goal);
  }
});

test('the submit button opens a recovery attempt for every goal', () => {
  const button = readFileSync(path.join(here, 'BlueprintSubmitButton.tsx'), 'utf8');
  assert.match(button, /\n\s+recovery: true,\n/);
  assert.doesNotMatch(button, /recovery: goal/);
});
