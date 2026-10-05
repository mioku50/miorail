import { expect, test } from '@playwright/test';

// Wallet MCP is one of the four main pages, and until 2026-10-04 a visitor
// clicking it met the wallet wall and nothing else. This is the visitor's
// view with no session and no catalogue: the page itself, the one thing to
// press, and Miorail's own plugin.
test('a visitor opens Wallet MCP and sees the page, not the wallet wall (390px)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/status') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });

  await page.goto('/extensions');
  await expect(page.getByRole('button', { name: 'Sign in to ask' })).toBeVisible();
  await expect(page.getByText('PRIVATE AREA')).toHaveCount(0);

  await expect(page.getByText('Miorail in your AI assistant')).toBeVisible();
  await expect(page.getByText('https://miorail.xyz/mcp/private', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the plugin' })).toHaveAttribute('href', '/wallet-mcp/miorail.md');

  // An example only fills the box; signing in is the way to ask it.
  await page.getByRole('button', { name: /What does my wallet hold\?/ }).click();
  await expect(page.locator('#base-mcp-console-input')).toHaveValue('What does my wallet hold?');
  await page.getByRole('button', { name: 'Sign in to ask' }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fextensions$/);
});

// A server session whose wallet is not in this browser is still signed out
// here. The walk on 10-05 found it offered two next steps at once: "Sign in to
// ask" in the console and "Connect Wallet MCP" under it.
test('a session without its wallet in this browser is offered one next step (390px)', async ({ page }) => {
  const wallet = '0x00000000000000000000000000000000000000a1';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') {
      return route.fulfill({ json: { user: { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } } });
    }
    if (path === '/api/status') {
      return route.fulfill({
        json: { baseMcp: { enabled: true, configured: true, status: 'needs_reauth', auth: { connected: false, needsReauth: true } } },
      });
    }
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });

  await page.goto('/extensions');
  await expect(page.getByRole('button', { name: 'Sign in to ask' })).toBeVisible();
  await expect(page.getByText('sign in to ask', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Wallet MCP' })).toHaveCount(0);
});

test('the Wallet MCP page fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: null } });
    if (path === '/api/status') return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
  });
  await page.goto('/extensions');
  await expect(page.getByRole('button', { name: 'Sign in to ask' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const width of [1280, 390]) {
  test(`Virtuals OTP keeps status private, requires explicit reveal and distinguishes failed reads (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const posts: string[] = [];
    let stage = 0;
    await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
      body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'POST') posts.push(path);
      if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture-user', address: '0x1111111111111111111111111111111111111111', chainId: 8453 } } });
      if (path === '/api/status') return route.fulfill({ json: { baseMcp: { enabled: true, configured: true, auth: { connected: true } } } });
      if (path === '/api/mcp/base/console') {
        const statuses = ['needs_input', 'needs_input', 'answered', 'answered', 'answered', 'failed'] as const;
        const errors = ['virtuals_otp_facts_required', 'virtuals_sign_in_required', null, null, null, 'virtuals_http_403'];
        const replies = [
          'Name an agent ID and message ID.',
          'Ask “Sign in to Virtuals” and approve that sign-in in your wallet, then repeat this OTP request. No agent will be created by sign-in.',
          'Virtuals found 1 candidate verification code in that message. The code is hidden; explicitly ask “Show Virtuals OTP code” with the same agent ID and message ID to see it.',
          'Virtuals candidate verification code: 012345. Validity and expiry were not checked. No code was submitted or used.',
          'Virtuals reports no candidate verification code in that message.',
          'private-provider-body-987654',
        ];
        expect(request.postDataJSON().message).toBe(stage === 0 ? 'Check my Virtuals email OTP status'
          : stage === 3 ? 'Show Virtuals OTP code for agent agent-1 message mail-1'
            : 'Check my Virtuals email OTP status for agent agent-1 message mail-1');
        return route.fulfill({ json: { status: statuses[stage], reply: replies[stage], errorCode: errors[stage],
          trace: stage < 2 ? [] : [{ tool: 'virtuals_agent_email_extract_otp', args: '{"agentId":"agent-1","messageId":"mail-1"}',
            ok: stage !== 5, result: stage === 4 ? '{"status":"not_found"}' : '{"privatePayload":"[redacted]"}', errorCode: errors[stage] }],
          toolsAvailable: 2, truncated: false, elapsedMs: 20, checkedAt: new Date().toISOString() } });
      }
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/extensions');
    for (stage = 0; stage < 6; stage++) {
      await page.locator('#base-mcp-console-input').fill(stage === 0 ? 'Check my Virtuals email OTP status'
        : stage === 3 ? 'Show Virtuals OTP code for agent agent-1 message mail-1'
          : 'Check my Virtuals email OTP status for agent agent-1 message mail-1');
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      if (stage === 0) await expect(page.getByText('Name an agent ID and message ID.', { exact: true })).toBeVisible();
      if (stage === 1) await expect(page.getByText(/No agent will be created by sign-in/)).toBeVisible();
      if (stage === 2) {
        await expect(page.getByText(/The code is hidden/)).toBeVisible();
        await expect(page.getByText(/012345/)).toHaveCount(0);
      }
      if (stage === 3) {
        await expect(page.getByText(/candidate verification code: 012345/)).toBeVisible();
        await expect(page.getByText(/Validity and expiry were not checked/)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('virtuals-explicit-code.png'), fullPage: false });
      }
      if (stage === 4) await expect(page.getByText('Virtuals reports no candidate verification code in that message.', { exact: true })).toBeVisible();
      if (stage === 5) {
        await expect(page.getByText(/Whether the message contains a code was not established/)).toBeVisible();
        await expect(page.getByText(/private-provider-body|987654/)).toHaveCount(0);
      }
      await expect(page.getByRole('link', { name: /Approve/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(posts.filter(path => path !== '/api/mcp/base/tools')).toEqual(Array(6).fill('/api/mcp/base/console'));
  });

  test(`Hydrex positions read renders raw units, empty and failed outcomes without an approval (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const posts: string[] = [];
    let stage = 0;
    await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
      body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'POST') posts.push(path);
      if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture-user', address: '0x1111111111111111111111111111111111111111', chainId: 8453 } } });
      if (path === '/api/status') return route.fulfill({ json: { baseMcp: { enabled: true, configured: true, auth: { connected: true } } } });
      if (path === '/api/mcp/base/console') {
        expect(request.postDataJSON().message).toBe('Show my Hydrex liquidity positions');
        const reply = stage === 0
          ? 'Hydrex positions on Base: 1. Showing 1.\nPosition #12345 · pool fee 0.05%\n0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 / 0x4200000000000000000000000000000000000006\nTick range -887220 → 887220 · liquidity (protocol units) 1500000000000000\nRecorded fees owed (raw token units): token0 12345678901234567890 · token1 0'
          : stage === 1 ? 'Hydrex reports no concentrated-liquidity positions on Base for the wallet you signed in with.'
            : 'Hydrex’s position list could not be read in full. Your positions were not established. Try again or open Hydrex.';
        return route.fulfill({ json: { status: stage === 2 ? 'failed' : 'answered', reply,
          trace: [{ tool: 'hydrex_get_positions', args: '{"chain":"base"}', ok: stage !== 2,
            result: '{}', errorCode: stage === 2 ? 'hydrex_positions_incomplete' : null }],
          toolsAvailable: 1, truncated: false, elapsedMs: 123, errorCode: stage === 2 ? 'hydrex_positions_incomplete' : null,
          checkedAt: new Date().toISOString(), cta: { label: 'Open Hydrex', url: 'https://hydrex.finance/' } } });
      }
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/extensions');
    await page.locator('#base-mcp-console-input').fill('Show my Hydrex liquidity positions');
    for (stage = 0; stage < 3; stage++) {
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      if (stage === 0) {
        await expect(page.getByText(/Position #12345 · pool fee/)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('hydrex-positions.png'), fullPage: false });
      }
      if (stage === 1) await expect(page.getByText(/Hydrex reports no concentrated-liquidity positions/)).toBeVisible();
      if (stage === 2) await expect(page.getByText(/Your positions were not established/)).toBeVisible();
      await expect(page.getByRole('link', { name: /Approve/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(posts.filter(path => path !== '/api/mcp/base/tools')).toEqual(Array(3).fill('/api/mcp/base/console'));
  });

  test(`Aerodrome claim shows a simulated Action Receipt and leaves approval to the wallet (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const wallet = '0x1111111111111111111111111111111111111111';
    const posts: string[] = [];
    await page.route('**/AuthProvider.tsx*', route => route.fulfill({ contentType: 'application/javascript',
      body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'POST') posts.push(path);
      if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: `eip155:8453:${wallet}`, address: wallet, chainId: 8453 } } });
      if (path === '/api/status') return route.fulfill({ json: { baseMcp: { enabled: true, configured: true, auth: { connected: true } } } });
      if (path === '/api/mcp/base/console') {
        const input = request.postDataJSON();
        expect(input.message).toBe('Claim my Aerodrome fees');
        expect(input.requestId).toBeTruthy();
        return route.fulfill({ json: { status: 'action', reply: 'Four claim calls passed batch simulation. Review fees and AERO in your wallet.',
          trace: [], toolsAvailable: 0, truncated: false, elapsedMs: 100, errorCode: null, checkedAt: new Date().toISOString(),
          action: { approvalUrl: 'https://keys.coinbase.com/approve/fixture-claim', resultPreview: null, receipt: {
            id: 'fixture-claim', schemaVersion: 'base-mcp-action-receipt/v1', chainId: 8453, provider: 'base-mcp',
            actionHash: `0x${'a'.repeat(64)}`, walletAddress: wallet, capabilityPolicy: 'passed',
            actionType: 'aerodrome_claim', operation: 'claim', recipient: wallet, claimCount: 4, poolsRead: 38794, poolsTotal: 38794,
            managedSkipped: 1, readBlock: '100', simulationStatus: 'passed', status: 'approval_required', reconciliationState: 'not_started',
            approvalRequired: true, routeVerified: false, reconciliationBasis: 'aerodrome_claim_events', transactionHash: null,
            blockNumber: null, errorCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finalizedAt: null,
          } } } });
      }
      return route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    });
    await page.goto('/extensions');
    await page.locator('#base-mcp-console-input').fill('Claim my Aerodrome fees');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText('4 claims', { exact: true })).toBeVisible();
    await expect(page.getByText('38794 / 38794', { exact: true })).toBeVisible();
    await expect(page.getByText('1 managed or locked positions excluded.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Approve/ })).toHaveAttribute('href', 'https://keys.coinbase.com/approve/fixture-claim');
    expect(posts.filter(path => path !== '/api/mcp/base/tools')).toEqual(['/api/mcp/base/console']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
