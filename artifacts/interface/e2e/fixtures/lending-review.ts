import { expect, type Page } from '@playwright/test';

export const WALLET = '0x1111111111111111111111111111111111111111';
export const OTHER = '0x2222222222222222222222222222222222222222';
export const NOW = new Date('2026-10-29T03:45:00Z');
export function ready() {
  return { state: 'ready', executionId: 'execution_1', callsHash: `0x${'1'.repeat(64)}`, signingTermsHash: `0x${'2'.repeat(64)}`, expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    atomicRequired: true, calls: [{ to: WALLET, data: '0x12345678', value: '0' }], steps: [{ index: 0, to: WALLET, reading: 'Repays debt without withdrawing collateral.' }],
    measured: { provider: 'fixture', blockNumber: 53_200_001, loanDeltaAssets: '-3000000' },
    facts: { operation: 'repay', venue: 'morpho', collateralTokenAddress: WALLET, collateralSymbol: 'cbBTC', collateralDecimals: 8, marketId: `0x${'a'.repeat(64)}`,
      amountMode: 'assets', requestedAssets: '3000000', maximumDebitAssets: '3000000', collateralSupplyAssets: '0', debtBeforeAssets: '3125001', debtAfterAssets: '125001', collateralBeforeAssets: '1234567', collateralAfterAssets: '1234567', debtBeforeShares: '3125001000000', debtAfterShares: '125001000000', blockNumber: 53_200_000, warnings: [] } };
}
/** A stock loan the server granted in steps, for a wallet without batches: approve, supply, borrow. */
export function stepsReady() {
  const spoke = '0x17905db0e4a3514467539956c084180616ae7b8d', stock = '0x3333333333333333333333333333333333333333';
  return { ...ready(), atomicRequired: false, delivery: 'sequential',
    calls: [{ to: stock, data: '0x095ea7b3', value: '0' }, { to: spoke, data: '0x12345601', value: '0' }, { to: spoke, data: '0x12345602', value: '0' }],
    steps: [{ index: 0, to: stock, reading: 'Allows only the registered Aave Spoke to move up to 1000000 atomic units; the next step uses exactly this allowance.' },
      { index: 1, to: spoke, reading: 'Supplies exactly the selected stock amount for this wallet.' }, { index: 2, to: spoke, reading: 'Borrows the exact selected USDC amount for this wallet.' }],
    measured: { ...ready().measured, loanDeltaAssets: '180000' },
    facts: { ...ready().facts, operation: 'borrow', venue: 'aave-v4', collateralTokenAddress: stock, collateralSymbol: 'NVDAc', collateralDecimals: 18, marketId: spoke,
      requestedAssets: '180000', maximumDebitAssets: '0', collateralSupplyAssets: '1000000', debtBeforeAssets: '0', debtAfterAssets: '180000', debtBeforeShares: '0', debtAfterShares: '180000',
      warnings: ['Your wallet sends this as 3 steps, one transaction each, and pays each network fee. Still reviews each next step again before your wallet asks for it.'] } };
}
const stepHash = (n: number) => `0x${String(n).padStart(64, '0')}`;
export type FixtureWindow = Window & {
  lendingStepSends: string[];
  lendingWalletAttempts: number;
  setLendingFixtureIdentity: (next: { session: string; connected: string }) => void;
  finishLendingWallet: (batch: string) => void;
  /** Takes the review off the page, as leaving it does. */
  closeLendingReview: () => void;
};
export async function install(page: Page, outcome: 'submitted' | 'timeout' | 'rejected' | 'pending' | 'unsupported' | 'steps' | 'steps-declined' = 'submitted') {
  await page.clock.setFixedTime(NOW);
  await page.route('https://**/*', route => route.abort('blockedbyclient'));
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}) {return children;} export function useAuthGate(){return{showPrivateSurfaces:true,phase:"authenticated",sessionAuthenticated:true};}' }));
  const state = { response: ready() as Record<string, unknown>, reviewReads: 0, order: [] as string[], executionState: 'ready', failRefresh: false, transactionHints: [] as string[],
    stepsResponse: stepsReady() as Record<string, unknown>, stepAnswers: [] as Array<Record<string, unknown>>, reviewQueries: [] as string[],
    stoppedOnPurpose: false, lastStepHash: null as string | null,
    // A loan in steps left part way, as the server reads it, and its answers to Stop here, in order.
    stepsStanding: null as Record<string, unknown> | null, errorCode: null as string | null, refusedFacts: ready().facts as Record<string, unknown>,
    stopAnswers: [] as Array<{ status: number; json: Record<string, unknown> }>,
    // Holds the arm's answer until it settles, as a slow server would.
    armHeld: null as Promise<void> | null };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    if (path.includes('/rwa/lending/review/')) {
      state.order.push('review'); state.reviewReads++; state.reviewQueries.push(new URL(request.url()).search);
      if (state.failRefresh) return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
      const steps = new URL(request.url()).searchParams.get('delivery') === 'sequential';
      return route.fulfill({ json: state.executionState === 'ready' ? steps ? state.stepsResponse : state.response : {
        state: 'refused', refusal: 'lending_submission_pending', detail: 'This review has an existing wallet attempt.',
        executionId: 'execution_1', executionState: state.executionState, facts: state.refusedFacts,
      } });
    }
    if (path.endsWith('/executions/execution_1/arm') && request.method() === 'POST') {
      state.order.push('arm'); state.executionState = 'awaiting_wallet';
      if (state.armHeld) await state.armHeld;
      expect(request.postDataJSON().callsHash).toBe(state.response.callsHash);
      expect(request.postDataJSON().signingTermsHash).toBe(state.response.signingTermsHash);
      return route.fulfill({ json: { attemptId: 'attempt_1' } });
    }
    if (path.endsWith('/executions/execution_1/submission') && request.method() === 'POST') {
      const body = request.postDataJSON(); state.order.push(`submission:${body.outcome}`);
      expect(body.attemptId).toBe('attempt_1');
      // As the server: a stop on purpose is final once what landed is read, and holds nothing.
      state.stoppedOnPurpose = body.outcome === 'stopped';
      state.executionState = body.outcome === 'rejected' ? 'ready' : body.outcome === 'stopped' ? 'failed' : body.outcome;
      return route.fulfill({ json: { executionId: 'execution_1', state: state.executionState } });
    }
    if (path.endsWith('/executions/execution_1/steps') && request.method() === 'POST') {
      const body = request.postDataJSON(); state.order.push(`step:${body.index}`); state.lastStepHash = body.transactionHash;
      expect(body.attemptId).toBe('attempt_1');
      expect(body.transactionHash).toBe(stepHash(body.index + 1));
      const answer = state.stepAnswers[body.index] ?? (body.index === 2 ? { state: 'submitted', batchId: 'fixture-steps-3' } : { state: 'next', index: body.index + 1, batchId: `fixture-steps-${body.index + 1}` });
      if (answer.state === 'submitted') state.executionState = 'submitted';
      return route.fulfill({ json: answer });
    }
    if (path.endsWith('/executions/execution_1/transaction') && request.method() === 'POST') {
      state.order.push('hint'); state.transactionHints.push(request.postDataJSON().transactionHash);
      state.executionState = 'unknown';
      return route.fulfill({ json: { executionId: 'execution_1', state: 'unknown', transactionHash: request.postDataJSON().transactionHash, errorCode: 'loan_transaction_hint_unverified' } });
    }
    if (path.endsWith('/executions/execution_1/stop') && request.method() === 'POST') {
      state.order.push('stop');
      const answer = state.stopAnswers.shift() ?? { status: 503, json: { error: 'fixture_unavailable' } };
      if (answer.status === 200) {
        state.executionState = String(answer.json.state); state.errorCode = answer.json.errorCode as string | null; state.stepsStanding = answer.json.steps as Record<string, unknown> | null;
      }
      return route.fulfill({ status: answer.status, json: answer.json });
    }
    if (path.endsWith('/executions/execution_1') && request.method() === 'GET') {
      state.order.push('result');
      return route.fulfill({ json: { executionId: 'execution_1', state: state.executionState,
        transactionHash: state.executionState === 'confirmed' ? `0x${'9'.repeat(64)}` : state.stoppedOnPurpose ? state.lastStepHash : null,
        errorCode: state.errorCode ?? (state.stoppedOnPurpose ? 'loan_steps_stopped' : null), ...(state.stepsStanding ? { steps: state.stepsStanding } : {}) } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  const uiRoot = '/@fs' + new URL('../../../../lib/ui/src/console/', import.meta.url).pathname;
  const source = await (await page.request.get(`${uiRoot}useLendingReviewConsole.ts`)).text();
  const reactPath = source.match(/from ["']([^"']*\/react\.js\?v=[^"']+)["']/)?.[1]; expect(reactPath).toBeTruthy();
  await page.route('**/LendingReviewPage.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${reactPath}';
    import {useLendingReviewConsoleV1} from '${uiRoot}useLendingReviewConsole.ts';
    import {LendingReviewScreen} from '${uiRoot}LendingReviewScreen.tsx';
    window.lendingWalletAttempts=0;
    export function LendingReviewPage(){
      const [open,setOpen]=React.useState(true);
      window.closeLendingReview=()=>setOpen(false);
      return open ? React.createElement(Review) : React.createElement('main',{className:'still'},'Left the review');
    }
    function Review(){
      const [identity,setIdentity]=React.useState({session:'${WALLET}',connected:'${WALLET}'});
      window.setLendingFixtureIdentity=setIdentity;
      const {model}=useLendingReviewConsoleV1({draft:decodeURIComponent(location.pathname.split('/').pop()),sessionWalletAddress:identity.session,walletAddress:identity.connected,
        sendCalls:async()=>{ window.lendingWalletAttempts++;
          ${outcome === 'timeout' ? "throw new Error('wallet response lost');" : outcome === 'rejected' ? "throw Object.assign(new Error('declined'),{code:4001});" : outcome === 'unsupported' ? "throw Object.assign(new Error('An internal error was received.'),{code:-32603,details:'atomic batch is not supported'});" : outcome === 'pending' ? 'return await new Promise(resolve=>{window.finishLendingWallet=resolve;});' : "return 'fixture-batch';"}
        },
        onWalletRefusal:()=>{ window.lendingWalletRefusals=(window.lendingWalletRefusals??0)+1; },
        ${outcome.startsWith('steps') ? `steps:{
          send:async call=>{ window.lendingStepSends=[...(window.lendingStepSends??[]),call.to];
            ${outcome === 'steps-declined' ? "if(window.lendingStepSends.length===2) throw Object.assign(new Error('declined'),{code:4001});" : ''}
            return '0x'+String(window.lendingStepSends.length).padStart(64,'0'); },
          receipt:async()=>'success' },` : ''}});
      return React.createElement('main',{className:'still'},React.createElement(LendingReviewScreen,{model}));
    }
  ` }));
  return state;
}
export const attempts = (page: Page) => page.evaluate(() => (window as FixtureWindow).lendingWalletAttempts);
