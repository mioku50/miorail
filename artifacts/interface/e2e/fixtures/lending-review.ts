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
export type FixtureWindow = Window & {
  lendingWalletAttempts: number;
  setLendingFixtureIdentity: (next: { session: string; connected: string }) => void;
  finishLendingWallet: (batch: string) => void;
};
export async function install(page: Page, outcome: 'submitted' | 'timeout' | 'rejected' | 'pending' = 'submitted') {
  await page.clock.setFixedTime(NOW);
  await page.route('https://**/*', route => route.abort('blockedbyclient'));
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}) {return children;} export function useAuthGate(){return{showPrivateSurfaces:true,phase:"authenticated",sessionAuthenticated:true};}' }));
  const state = { response: ready() as Record<string, unknown>, reviewReads: 0, order: [] as string[], executionState: 'ready', failRefresh: false, transactionHints: [] as string[] };
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 } } });
    if (path.includes('/rwa/lending/review/')) {
      state.order.push('review'); state.reviewReads++;
      if (state.failRefresh) return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
      return route.fulfill({ json: state.executionState === 'ready' ? state.response : {
        state: 'refused', refusal: 'lending_submission_pending', detail: 'This review has an existing wallet attempt.',
        executionId: 'execution_1', executionState: state.executionState, facts: ready().facts,
      } });
    }
    if (path.endsWith('/executions/execution_1/arm') && request.method() === 'POST') {
      state.order.push('arm'); state.executionState = 'awaiting_wallet';
      expect(request.postDataJSON().callsHash).toBe(state.response.callsHash);
      expect(request.postDataJSON().signingTermsHash).toBe(state.response.signingTermsHash);
      return route.fulfill({ json: { attemptId: 'attempt_1' } });
    }
    if (path.endsWith('/executions/execution_1/submission') && request.method() === 'POST') {
      const body = request.postDataJSON(); state.order.push(`submission:${body.outcome}`);
      expect(body.attemptId).toBe('attempt_1');
      state.executionState = body.outcome === 'rejected' ? 'ready' : body.outcome;
      return route.fulfill({ json: { executionId: 'execution_1', state: state.executionState } });
    }
    if (path.endsWith('/executions/execution_1/transaction') && request.method() === 'POST') {
      state.order.push('hint'); state.transactionHints.push(request.postDataJSON().transactionHash);
      state.executionState = 'unknown';
      return route.fulfill({ json: { executionId: 'execution_1', state: 'unknown', transactionHash: request.postDataJSON().transactionHash, errorCode: 'loan_transaction_hint_unverified' } });
    }
    if (path.endsWith('/executions/execution_1') && request.method() === 'GET') {
      state.order.push('result');
      return route.fulfill({ json: { executionId: 'execution_1', state: state.executionState,
        transactionHash: state.executionState === 'confirmed' ? `0x${'9'.repeat(64)}` : null, errorCode: null } });
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
      const [identity,setIdentity]=React.useState({session:'${WALLET}',connected:'${WALLET}'});
      window.setLendingFixtureIdentity=setIdentity;
      const {model}=useLendingReviewConsoleV1({draft:decodeURIComponent(location.pathname.split('/').pop()),sessionWalletAddress:identity.session,walletAddress:identity.connected,
        sendCalls:async()=>{ window.lendingWalletAttempts++;
          ${outcome === 'timeout' ? "throw new Error('wallet response lost');" : outcome === 'rejected' ? "throw Object.assign(new Error('declined'),{code:4001});" : outcome === 'pending' ? 'return await new Promise(resolve=>{window.finishLendingWallet=resolve;});' : "return 'fixture-batch';"}
        }});
      return React.createElement('main',{className:'still'},React.createElement(LendingReviewScreen,{model}));
    }
  ` }));
  return state;
}
export const attempts = (page: Page) => page.evaluate(() => (window as FixtureWindow).lendingWalletAttempts);
