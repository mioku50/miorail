import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as classifiers from '../src/console/walletBatchSupport';
import * as sellAmount from '../src/console/stockSellAmount';

// ---------------------------------------------------------------------------
// Audits N13-2 and N13-3 (2026-11-13), on the stock review's wallet press.
//
// N13-2: nothing was recorded before the wallet was asked. A wallet that sent
// the purchase and lost its answer read as "Nothing was submitted", the button
// came back, and a reload forgot the press, so the same purchase could be
// asked of the wallet again.
// N13-3: the host sent as whichever account the wallet had selected; the
// server's release names the account the review was made for.
//
// The hook runs here as the page runs it, transpiled, with the server and the
// wallet replaced by doubles that keep the server's own rules: one open attempt
// per blueprint, a cancelled or failed record closes it, and a release is
// refused while an earlier one of this stock action is held.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const A = `0x${'a'.repeat(40)}`;
const HASH = `0x${'1'.repeat(64)}`;

interface Server {
  releases: number;
  attempts: Array<{ id: string; blueprintId: string; open: boolean }>;
  records: Array<{ status: string; submissionAttemptId?: string; batchId?: string }>;
  bound: string[];
  sends: Array<{ from: string; chainId: number; calls: unknown[] }>;
  release: () => Promise<unknown>;
  createAttempt?: () => Promise<unknown>;
}

function server(): Server {
  const state: Server = {
    releases: 0, attempts: [], records: [], bound: [], sends: [],
    release: async () => {
      state.releases += 1;
      // The server's own guard: while an attempt of this stock action is open, nothing more is released.
      if (state.attempts.some((attempt) => attempt.open)) throw new Error('stock_action_handoff_open: already handed to the wallet');
      return {
        action: { chainId: 8453, from: A, calls: [{ to: `0x${'2'.repeat(40)}`, data: '0x1234', value: '0x0' }], atomicRequired: true },
        routeRunId: 'run-1', blueprintId: `bp-${state.releases}`, approvedCallsHash: HASH,
      };
    },
  };
  return state;
}

function page(api: Server, wallet: (batch: { from: string; chainId: number; calls: unknown[] }) => Promise<string | null>) {
  let cells: unknown[] = [];
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
    useMemo: (fn: () => unknown) => fn(),
  };
  const client = {
    useStockActionReview: () => ({ data: { outcome: 'review', question: { direction: 'buy' }, representation: { tokenAddress: `0x${'2'.repeat(40)}` } }, isLoading: false }),
    useStockActionConfirm: () => ({ variables: { draft: 'draft-1' }, data: { clearance: 'clearance-1' }, isPending: false }),
    useStockActionSellTerms: () => ({ isPending: false }),
    useStockActionRelease: () => ({ isPending: false, mutateAsync: () => api.release() }),
    useCreateSubmissionAttempt: () => ({
      mutateAsync: async (input: { blueprintId: string; walletAddress: string }) => {
        if (api.createAttempt) return api.createAttempt();
        assert.equal(input.walletAddress, A, 'the attempt belongs to the account the server released for');
        if (api.attempts.some((attempt) => attempt.blueprintId === input.blueprintId && attempt.open)) throw new Error('submission_attempt_open');
        const attempt = { id: `attempt-${api.attempts.length + 1}`, blueprintId: input.blueprintId, open: true };
        api.attempts.push(attempt);
        return { attempt: { id: attempt.id } };
      },
    }),
    useBindSubmissionBatch: () => ({ mutateAsync: async (input: { batchId: string }) => { api.bound.push(input.batchId); return {}; } }),
    useRecordBlueprintSubmission: () => ({
      mutateAsync: async (input: { status: string; submissionAttemptId?: string; batchId?: string }) => {
        api.records.push({ status: input.status, submissionAttemptId: input.submissionAttemptId, batchId: input.batchId });
        // recordAttemptOutcomeV1: a cancelled or failed record closes the attempt it names.
        const attempt = api.attempts.find((row) => row.id === input.submissionAttemptId);
        if (attempt && (input.status === 'cancelled' || input.status === 'failed')) attempt.open = false;
        return { proofId: 'proof-1', finalStatus: 'pending' };
      },
    }),
  };
  const source = readFileSync(path.join(here, '../src/console/stockActionReviewConsole.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(js, {
    exports: mod.exports, module: mod, console, Error, Promise, JSON, String, Number, Boolean, Array, Object, RegExp, Set, Map,
    require: (name: string) => {
      const known: Record<string, unknown> = { react, '@mioagent/api-client-react': client, './walletBatchSupport': classifiers, './stockSellAmount': sellAmount };
      if (name in known) return known[name];
      throw new Error(`unexpected import ${name}`);
    },
  });
  const hook = mod.exports.useStockActionReviewConsoleV1 as (input: Record<string, unknown>) => { model: { wallet: {
    pending: boolean; error: string | null; blocked: boolean; batchId: string | null; onOpen: () => void } } };
  const render = () => {
    cursor = 0;
    return hook({ draft: 'draft-1', sendCalls: async (batch: { from: string; chainId: number; calls: unknown[] }) => { api.sends.push(batch); return wallet(batch); } }).model.wallet;
  };
  return {
    copy: mod.exports as Record<string, string>,
    async press() {
      render().onOpen();
      for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
      return render();
    },
    /** A reload: the page's own memory is gone, the server's is not. */
    reload() { cells = []; },
  };
}

test('a wallet answer that never came back holds the purchase: no second wallet request, on this page or after a reload (audit N13-2)', async () => {
  const api = server();
  let asked = 0;
  const review = page(api, async () => { asked += 1; throw new Error('connection closed after wallet broadcast'); });
  const first = await review.press();
  assert.equal(asked, 1);
  assert.equal(first.error, review.copy.STOCK_SEND_UNREAD_V1);
  assert.doesNotMatch(first.error ?? '', /Nothing was submitted/);
  assert.equal(first.blocked, true, 'the button is not offered again');
  assert.equal(api.attempts[0]!.open, true, 'opened before the wallet, and left open');
  assert.deepEqual(api.records, [], 'nothing is recorded as cancelled or failed');

  const again = await review.press();
  assert.equal(asked, 1);
  assert.equal(api.releases, 1, 'a locked press asks the server nothing');
  assert.equal(again.error, review.copy.STOCK_SEND_UNREAD_V1);

  review.reload();
  const reloaded = await review.press();
  assert.equal(asked, 1, 'a reload does not ask the wallet again');
  assert.equal(reloaded.error, review.copy.STOCK_HANDOFF_OPEN_V1);
  assert.equal(reloaded.blocked, true);
});

test('the purchase is sent as the account the server released it for, on Base (audit N13-3)', async () => {
  const api = server();
  const review = page(api, async () => 'batch-1');
  const done = await review.press();
  assert.deepEqual(api.sends.map((send) => [send.from, send.chainId]), [[A, 8453]]);
  assert.equal(done.batchId, 'batch-1');
  assert.deepEqual(api.bound, ['batch-1']);
  assert.deepEqual(api.records, [{ status: 'submitted', submissionAttemptId: 'attempt-1', batchId: 'batch-1' }]);
});

test('a release that names no account or another network offers nothing to the wallet', async () => {
  for (const action of [{ chainId: 8453 }, { chainId: 8453, from: 'not-an-address' }, { chainId: 1, from: A }]) {
    const api = server();
    api.release = async () => ({ action: { ...action, calls: [{ to: A, data: '0x', value: '0x0' }] }, routeRunId: 'run-1', blueprintId: 'bp-1', approvedCallsHash: HASH });
    const review = page(api, async () => 'batch-1');
    const after = await review.press();
    assert.equal(api.sends.length, 0, JSON.stringify(action));
    assert.equal(api.attempts.length, 0);
    assert.match(after.error ?? '', /did not name the account and network these calls are for, so nothing was offered to your wallet/);
  }
});

test('the person’s own No closes the attempt, and the next press asks the wallet again', async () => {
  const api = server();
  let asked = 0;
  const review = page(api, async () => {
    asked += 1;
    if (asked === 1) throw Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError', code: 4001 });
    return 'batch-2';
  });
  const declined = await review.press();
  assert.equal(declined.error, 'You declined the batch in your wallet. Nothing was submitted, and nothing changed.');
  assert.equal(declined.blocked, false);
  assert.deepEqual(api.records.map((row) => [row.status, row.submissionAttemptId]), [['cancelled', 'attempt-1']]);
  assert.equal(api.attempts[0]!.open, false);
  const sent = await review.press();
  assert.equal(asked, 2);
  assert.equal(sent.batchId, 'batch-2');
});

test('a wallet answering as another account is not asked, and says so; the attempt closes', async () => {
  const api = server();
  const review = page(api, async () => { throw Object.assign(new Error(`Account "${A}" not found for connector "MetaMask".`), { name: 'ConnectorAccountNotFoundError' }); });
  const refused = await review.press();
  assert.match(refused.error ?? '', /^Your wallet switched to another account, so it was not asked and nothing was sent\. Switch back to 0xaaaa…aaaa, then press again\.$/);
  assert.deepEqual(api.records.map((row) => row.status), ['failed']);
  assert.equal(api.attempts[0]!.open, false);
});

test('no wallet is asked when the handoff cannot be written down first', async () => {
  const api = server();
  api.createAttempt = async () => { throw new Error('storage_unavailable'); };
  const review = page(api, async () => 'batch-1');
  const after = await review.press();
  assert.equal(api.sends.length, 0);
  assert.equal(after.error, review.copy.STOCK_HANDOFF_UNRECORDED_V1);
  assert.equal(after.blocked, false, 'nothing went out, so a later press may try again');
});

test('a server that refuses for a purchase already sent says so, and offers nothing', async () => {
  const api = server();
  api.release = async () => { api.releases += 1; throw new Error('stock_action_already_sent: reached Base once'); };
  const review = page(api, async () => 'batch-1');
  const after = await review.press();
  assert.equal(api.sends.length, 0);
  assert.equal(after.error, review.copy.STOCK_ALREADY_SENT_V1);
  assert.equal(after.blocked, true);
});

test('a server without recovery still asks the wallet, as a swap does, and records with no attempt', async () => {
  const api = server();
  api.createAttempt = async () => { throw new Error('submission_recovery_disabled'); };
  const review = page(api, async () => 'batch-1');
  const after = await review.press();
  assert.equal(api.sends.length, 1);
  assert.equal(after.batchId, 'batch-1');
  assert.deepEqual(api.records, [{ status: 'submitted', submissionAttemptId: undefined, batchId: 'batch-1' }]);
});
