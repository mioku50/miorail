import { expect, test, type Page } from '@playwright/test';

// The actual console frame, swap screens and recovery rail, with two old
// wallet requests. All network access is intercepted; the signing slot only
// counts a click and cannot reach a wallet.
const NOW = new Date('2026-11-06T14:00:00Z');
const WALLET = `0x${'1'.repeat(40)}`;

async function install(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.route('https://**/*', route => route.abort('blockedbyclient'));
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}){return children;} export function useAuthGate(){return{showPrivateSurfaces:true,phase:"authenticated",sessionAuthenticated:true};}' }));
  const attempts = [1, 2].map(n => ({
    id: `old-attempt-${n}`, walletAddress: WALLET, chainId: 8453, goal: 'swap', routeRunId: `old-run-${n}`,
    blueprintId: `old-blueprint-${n}`, approvedCallsHash: `0x${'a'.repeat(64)}`, proofId: null, batchId: null,
    status: 'wallet_pending', errorCode: null, createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:00:00Z', completedAt: null,
  }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/submission-attempts/recoverable')) return route.fulfill({ json: { attempts } });
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture', address: WALLET, chainId: 8453 } } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  const ui = '/@fs' + new URL('../../../lib/ui/src/', import.meta.url).pathname;
  const wallet = '/@fs' + new URL('../../../lib/wallet-actions/src/', import.meta.url).pathname;
  const source = await (await page.request.get(`${ui}console/ConsoleScreens.tsx`)).text();
  const react = source.match(/from ["']([^"']*\/react\.js\?v=[^"']+)["']/)?.[1];
  expect(react).toBeTruthy();
  await page.route('**/RouteIntelligenceConsole.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${react}';
    import {ConsoleShell,ConsoleFrameContextV1} from '${ui}console/ConsoleShell.tsx';
    import {RouteScreen,ReviewScreen} from '${ui}console/ConsoleScreens.tsx';
    import {StillConsolePage} from '${ui}still/StillConsole.tsx';
    import {skyStateV1} from '${ui}still/skyState.ts';
    import {SubmissionRecoveryRail} from '${wallet}SubmissionRecoveryRail.tsx';
    const e=React.createElement, noop=()=>{}, sky=skyStateV1({now:new Date('${NOW.toISOString()}')});
    const steps=['Intent','Evidence','Quotes','Score','Route','Simulate','Wallet','Proof'].map((name,i)=>({name,state:i<6?'done':'todo',timing:i<6?'0.2s':'—'}));
    function Frame(props){return e(StillConsolePage,{...props,tab:'more',sky});}
    export function RouteIntelligenceConsole(){
      const [review,setReview]=React.useState(false),[asked,setAsked]=React.useState(false);
      window.layoutWalletClicks=window.layoutWalletClicks??0;
      const simulation={available:true,passed:true,headline:'Simulation passed',detail:'',subLabel:'block 123 · just now',canSign:true,disabledReason:null};
      const content=review?e(ReviewScreen,{steps,simulation,
        calls:[{index:1,title:'Allow KyberSwap to spend exactly 2 USDC',detail:'spender 0x2222222222222222222222222222222222222222 · token 0x3333333333333333333333333333333333333333 · exact amount, no unlimited approval',mono:true},
          {index:2,title:'Swap through the selected route',detail:'Recipient is your own wallet · expires 2026-11-06T14:00:20Z',mono:true}],
        balanceTitle:'Balance changes',balanceBasis:'from the quote',balanceChanges:[
          {asset:'USDC',before:'—',after:'—',change:'−2 USDC'},
          {asset:'AAPLc',before:'—',after:'—',change:'+0.0058 AAPLc · at least 0.0057'}],
        checks:Array.from({length:16},(_,i)=>({label:'Verified check '+i,passed:true})),limits:[],onLimitChange:noop,onApprove:noop,onBack:()=>setReview(false),approvePending:false,
        tokenPanels:e('div',{className:'panel'},Array.from({length:40},(_,i)=>e('p',{key:i},'Additional contract evidence '+i))),
        signSlot:e('button',{className:'btn lg',disabled:asked,onClick:()=>{window.layoutWalletClicks++;setAsked(true);}},asked?'Wallet opened for approval':'Confirm in your wallet')
      }):e(RouteScreen,{steps,eyebrow:'Swap 2 USDC to AAPLc',amount:'0.0058',unit:'AAPLc',usd:'',providerLabel:'KyberSwap',
        freshness:{label:'quote just now',tone:'n'},why:'Expected output for your selected route.',kpis:[],graph:null,graphUnavailableReason:'No pool breakdown',graphLegend:[],
        simulatedPill:{label:'not simulated yet',tone:'n'},scoreRows:[],scoringVersion:'fixture',providerHistory:[],candidates:[],diagnostics:[],claimHeadline:null,
        onReview:()=>setReview(true),onSelectCandidate:noop,reviewDisabledReason:null,onCompareAgain:noop,comparePending:false,onChangeGoal:noop,
        tokenPanels:e('div',{className:'panel'},Array.from({length:40},(_,i)=>e('p',{key:i},'Additional contract evidence '+i))) });
      return e(ConsoleFrameContextV1.Provider,{value:Frame},e(ConsoleShell,{
        header:{crumb:['Swap AI',review?'Review':'Route'],nav:[]},
        left:{nav:[{id:'routes',label:'Swap AI',active:true,available:true}],sessions:[],sessionCount:'0',proofs:[],proofCount:'0'},
        footer:{},right:e('div',{className:'panel'},e('div',{className:'ph'},'Live data')),
        theme:'light',onThemeChange:noop,onNewGoal:noop,onSelectSession:noop,onSelectProof:noop,
      },e(SubmissionRecoveryRail,{walletAddress:'${WALLET}',chainId:8453,compact:true}),content));
    }
    export default RouteIntelligenceConsole;
  ` }));
}

for (const width of [390, 1280]) {
  test(`swap and signing actions precede history and evidence (${width}px)`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 844 });
    await install(page);
    await page.goto('/routes');
    const review = page.getByRole('button', { name: 'Review transaction', exact: true });
    await expect(review).toBeInViewport({ ratio: 1 });
    await expect(page.getByText('Wallet requests to check · 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Unfinished submission' }).first()).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await review.click();
    const sign = page.getByRole('button', { name: 'Confirm in your wallet', exact: true });
    await page.screenshot({ path: test.info().outputPath('review-first-screen.png') });
    // No scrollIntoView here: this is exactly what the old layout required.
    await expect(sign).toBeInViewport({ ratio: 1 });
    // Viewport intersection alone passes even when the fixed mobile nav hides
    // the action. Check the whole button against the actual painted elements.
    expect(await sign.evaluate(button => {
      const box = button.getBoundingClientRect();
      return [box.top + 2, box.bottom - 2].every(y => {
        const painted = document.elementFromPoint(box.x + box.width / 2, y);
        return painted === button || button.contains(painted);
      });
    })).toBe(true);
    await expect(page.getByText('Allow KyberSwap to spend exactly 2 USDC', { exact: true })).toBeVisible();
    const order = await page.evaluate(() => {
      const action = document.querySelector('.cta-dock'), history = document.querySelector('.still-execution');
      return Boolean(action && history && (action.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(order).toBe(true);
    await page.getByText('Pre-flight', { exact: true }).scrollIntoViewIfNeeded();
    await expect(sign).toBeInViewport({ ratio: 1 });
    expect(await sign.evaluate(button => {
      const box = button.getBoundingClientRect();
      return [box.top + 2, box.bottom - 2].every(y => {
        const painted = document.elementFromPoint(box.x + box.width / 2, y);
        return painted === button || button.contains(painted);
      });
    })).toBe(true);
    await sign.click();
    await expect(page.getByRole('button', { name: 'Wallet opened for approval' })).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { layoutWalletClicks: number }).layoutWalletClicks)).toBe(1);
    await page.getByText('Call details', { exact: true }).first().click();
    await expect(page.getByText('spender 0x2222222222222222222222222222222222222222 · token 0x3333333333333333333333333333333333333333 · exact amount, no unlimited approval', { exact: true })).toBeVisible();
    await page.getByLabel('Wallet requests to check').getByText('Wallet requests to check · 2', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unfinished submission' })).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Open wallet activity' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Resume verification' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
