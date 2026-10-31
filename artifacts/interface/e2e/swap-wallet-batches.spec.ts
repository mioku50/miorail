import { expect, test, type Page } from '@playwright/test';

// The swap's wallet button, mounted in the running app with its own wagmi
// config, in front of wallets that cannot send one batch. On 2026-10-31 a
// Rabby swap of 7 USDC said "the wallet could not send this with the fee
// sponsored. Press again", and pressing again failed the same way: Rabby has
// neither wallet_getCapabilities nor wallet_sendCalls (its source answers
// -32601 for both). Every API call is intercepted; nothing signs or is sent.

const WALLET = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

type WalletKind = 'no-methods' | 'silent-capabilities';

async function install(page: Page, kind: WalletKind) {
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
  await page.addInitScript(({ wallet, kind }) => {
    // wagmi reconnects the injected wallet it finds in its own storage.
    localStorage.setItem('wagmi.recentConnectorId', '"injected"');
    localStorage.setItem('wagmi.injected.connected', 'true');
    const methods: string[] = [];
    Object.assign(window, { __walletMethods: methods, ethereum: {
      on() {}, removeListener() {},
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet];
        // A wallet that answers its capabilities with nothing, and still has
        // no way to send a batch.
        if (method === 'wallet_getCapabilities' && kind === 'silent-capabilities') return {};
        if (method.startsWith('wallet_')) {
          throw Object.assign(new Error(`method [${method}] doesn't has corresponding handler`), { code: -32601 });
        }
        if (/sign|send|transaction/i.test(method)) throw new Error('Fixture forbids wallet actions');
        return null;
      },
    } });
  }, { wallet: WALLET, kind });
  const state = { approvals: 0, records: [] as Array<Record<string, unknown>> };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture', address: WALLET, chainId: 8453 } } });
    if (path === '/api/route-intelligence/swap/blueprints/bp_1/approve' && request.method() === 'POST') {
      state.approvals += 1;
      return route.fulfill({ json: {
        outcome: 'approved',
        lifecycle: 'approved',
        payload: {
          blueprintId: 'bp_1', blueprintHash: HASH, approvedCallsHash: HASH, chainId: '0x2105', from: WALLET, atomicRequired: true,
          calls: [{ to: `0x${'2'.repeat(40)}`, value: '0x0', data: '0x095ea7b3' }, { to: `0x${'3'.repeat(40)}`, value: '0x0', data: '0x12345678' }],
        },
        // The offer that made the old screen blame the sponsor.
        sponsorship: { paymasterUrl: 'https://stills.lat/api/paymaster/sponsorship/fixture', context: { sponsorship: 'fixture' } },
      } });
    }
    if (path === '/api/route-intelligence/swap/blueprints/bp_1/submission' && request.method() === 'POST') {
      state.records.push(request.postDataJSON());
      return route.fulfill({ json: { proofId: 'proof_1', finalStatus: 'failed' } });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  // The swap's button, in place of a lazy page, inside the app's providers.
  const walletActions = '/@fs' + new URL('../../../lib/wallet-actions/src/', import.meta.url).pathname;
  const source = await (await page.request.get(`${walletActions}BlueprintSubmitButton.tsx`)).text();
  const reactPath = source.match(/from ["']([^"']*\/react\.js\?v=[^"']+)["']/)?.[1];
  expect(reactPath).toBeTruthy();
  await page.route('**/LendingReviewPage.tsx*', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '${reactPath}';
    import { BlueprintSubmitButton } from '${walletActions}BlueprintSubmitButton.tsx';
    export function LendingReviewPage() {
      return React.createElement('main', { className: 'mio-console' }, React.createElement('div', { className: 'ctarow cta-dock' },
        React.createElement(BlueprintSubmitButton, { className: 'btn lg', routeRunId: 'run_1', blueprintId: 'bp_1',
          blueprintHash: '${HASH}', quoteExpiry: '2099-01-01T00:00:00.000Z', failureNote: true })));
    }
  ` }));
  return state;
}

const walletMethods = (page: Page) => page.evaluate(() => (window as unknown as { __walletMethods: string[] }).__walletMethods);

test('a wallet with no batch methods is told so before the server approves anything', async ({ page }) => {
  const state = await install(page, 'no-methods');
  await page.goto('/lending/fixture-draft');
  const button = page.getByRole('button', { name: 'This wallet cannot send it', exact: true });
  await expect(button).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: /^This wallet cannot send several calls in one request/ })).toBeVisible();
  await expect(page.getByText(/fee sponsored|Press again/)).toHaveCount(0);
  expect(state.approvals).toBe(0);
  // Asked once: a missing method is an answer, not a blip to retry.
  expect((await walletMethods(page)).filter((method) => method === 'wallet_getCapabilities')).toHaveLength(1);
});

test('a wallet that cannot send the batch it was handed says why under the button, and the sponsor is not blamed', async ({ page }) => {
  const state = await install(page, 'silent-capabilities');
  await page.goto('/lending/fixture-draft');
  const button = page.getByRole('button', { name: 'Confirm in your wallet', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('alert').filter({ hasText: /^This wallet cannot send several calls in one request/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Failed — retry', exact: true })).toBeVisible();
  await expect(page.getByText(/fee sponsored|Press again/)).toHaveCount(0);
  expect(state.approvals).toBe(1);
  expect((await walletMethods(page))).toContain('wallet_sendCalls');
  expect(state.records).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringMatching(/^This wallet cannot send several calls/) })]);
});
