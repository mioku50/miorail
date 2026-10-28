import { expect, test, type Page } from '@playwright/test';
import { computeMirror } from '../../../lib/still-engine/src/mirror.js';
import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';

const NOW = new Date('2026-10-28T15:00:00Z');
const FIRST = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
type AgentFixtureWindowV1 = Window & {
  updateStillAgentFixture: (patch: { signedIn?: boolean; walletIdentity?: string | null }) => void;
  refreshStillAgentFixture: () => void;
  privateAgentPaints: string[];
};

async function install(page: Page) {
  const report = JSON.parse(JSON.stringify(computeMirror({ universe: universe(), snapshot: snapshot(EXAMPLE), calendar: calendar(),
    subject: { address: FIRST, name: null, input: 'fixture' }, assembledAt: NOW })));
  const uiRoot = '/@fs' + new URL('../../../lib/ui/src/still/', import.meta.url).pathname;
  const source = await (await page.request.get(`${uiRoot}StillAgent.tsx`)).text();
  const reactPath = source.match(/from ["']([^"']*\/react\.js\?v=[^"']+)["']/)?.[1];
  expect(reactPath).toBeTruthy();
  await page.route('https://**/*', route => route.abort('blockedbyclient'));
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'fixture_read_unavailable' } }));
  await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript', body:
    'export function AuthProvider({children}) { return children; } export function useAuthGate() { return {showPrivateSurfaces:true,phase:"authenticated",sessionAuthenticated:true}; }' }));
  await page.route('**/StillRoutes.tsx*', route => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${reactPath}';
    import {StillAgent} from '${uiRoot}StillAgent.tsx';
    import {skyStateV1} from '${uiRoot}skyState.ts';
    export function StillAgentPage() {
      const [model,setModel] = React.useState({sky:skyStateV1({now:new Date('${NOW.toISOString()}')}),report:${JSON.stringify(report)},
        dividends:null,dividendsReadState:'not_loaded',reading:false,signedIn:true,walletIdentity:'${FIRST}',russian:false});
      window.updateStillAgentFixture = patch => setModel(current => ({...current,...patch}));
      window.refreshStillAgentFixture = () => setModel(current => ({...current,report:{...current.report,reading:{...current.report.reading,block:'53100001'}}}));
      return React.createElement(React.Fragment,null,
        React.createElement('output',{'data-testid':'agent-session-owner'},model.signedIn ? model.walletIdentity : 'signed-out'),
        React.createElement(StillAgent,{model}));
    }
    export function StillConsoleFrame({children}) { return children; }
    export function StillHomeRoute() { return null; }
    export function StillWalletPage() { return null; }
    export function StillAssetsPage() { return null; }
    export function StillMorePage() { return null; }
    export function StillAssistantsPage() { return null; }
  ` }));
  await page.goto('/agent');
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
}

test('Agent keeps a chat on report refresh, then clears it before rendering a different session wallet', async ({ page }) => {
  await install(page);
  await page.getByRole('button', { name: 'How safe is my loan?', exact: true }).click();
  await expect(page.getByText(/Your \$240.17 loan on Aave: prices can fall/)).toBeVisible();
  await page.getByLabel('A question about your money', { exact: true }).fill('private draft for the first wallet');
  await page.evaluate(() => (window as unknown as AgentFixtureWindowV1).refreshStillAgentFixture());
  await expect(page.getByText(/Your \$240.17 loan on Aave: prices can fall/)).toBeVisible();
  await expect(page.getByLabel('A question about your money', { exact: true })).toHaveValue('private draft for the first wallet');
  await page.evaluate(second => {
    const w = window as unknown as AgentFixtureWindowV1;
    w.privateAgentPaints = [];
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="agent-session-owner"]')?.textContent === second &&
          document.body.textContent?.includes('Your $240.17 loan on Aave')) w.privateAgentPaints.push('old answer under new owner');
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
    // Keep the old report on purpose: this is the cache-transition edge.
    w.updateStillAgentFixture({ walletIdentity: second });
  }, SECOND);
  await expect(page.getByTestId('agent-session-owner')).toHaveText(SECOND);
  await expect(page.getByText(/Your \$240.17 loan on Aave: prices can fall/)).toHaveCount(0);
  await expect(page.getByLabel('A question about your money', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'How safe is my loan?', exact: true }).click();
  await expect(page.getByText('Your wallet report has not been read yet. No balance or loan conclusion is available.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as AgentFixtureWindowV1).privateAgentPaints)).toEqual([]);
});

test('signing out clears answers and drafts, and signing back in does not restore the old session chat', async ({ page }) => {
  await install(page);
  await page.getByRole('button', { name: 'How safe is my loan?', exact: true }).click();
  await expect(page.getByText(/Your \$240.17 loan on Aave: prices can fall/)).toBeVisible();
  await page.getByLabel('A question about your money', { exact: true }).fill('private draft');
  await page.evaluate(() => (window as unknown as AgentFixtureWindowV1).updateStillAgentFixture({ signedIn: false, walletIdentity: null }));
  await expect(page.getByTestId('agent-session-owner')).toHaveText('signed-out');
  await expect(page.getByText(/Your \$240.17 loan on Aave: prices can fall/)).toHaveCount(0);
  await expect(page.getByLabel('A question about your money', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'How safe is my loan?', exact: true }).click();
  await expect(page.getByText('That needs your wallet: sign in and I will read it on Base.', { exact: true })).toBeVisible();
  await page.evaluate(first => (window as unknown as AgentFixtureWindowV1).updateStillAgentFixture({ signedIn: true, walletIdentity: first }), FIRST);
  await expect(page.getByText('Ask about your money.', { exact: true })).toBeVisible();
  await expect(page.locator('.still-bubble')).toHaveCount(0);
});
