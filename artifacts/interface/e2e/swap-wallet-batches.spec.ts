import { expect, test, type Page } from '@playwright/test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, erc20Abi, multicall3Abi } from 'viem';

// The swap's wallet button, mounted in the running app with its own wagmi
// config, in front of wallets that cannot send one batch. On 2026-10-31 a
// Rabby swap of 7 USDC said "the wallet could not send this with the fee
// sponsored. Press again", and pressing again failed the same way: Rabby has
// neither wallet_getCapabilities nor wallet_sendCalls (its source answers
// -32601 for both). The operator then chose steps for such wallets: an
// allowance for exactly the amount, and the swap once it has landed.
//
// Every API and RPC call is intercepted; nothing is signed or broadcast.

const WALLET = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ROUTER = `0x${'6'.repeat(40)}`;
const AMOUNT = 7_000_000n;
const ALLOWANCE_DATA = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, AMOUNT] });
const SWAP_DATA = '0x12345678';
const TX = [`0x${'b1'.repeat(32)}`, `0x${'b2'.repeat(32)}`, `0x${'b3'.repeat(32)}`];

type WalletKind = 'no-methods' | 'silent-capabilities';

const receiptOf = (hash: string) => ({
  transactionHash: hash, status: '0x1', blockNumber: '0x10', blockHash: `0x${'c'.repeat(64)}`, gasUsed: '0x5208',
  cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', from: WALLET, to: ROUTER, contractAddress: null,
  logs: [], logsBloom: `0x${'0'.repeat(512)}`, transactionIndex: '0x0', type: '0x2',
});

async function install(page: Page, kind: WalletKind, options: { declineSwapOnce?: boolean } = {}) {
  await page.route('**/AuthProvider.tsx*', (route) => route.fulfill({ contentType: 'application/javascript',
    body: 'export function AuthProvider({children}) { return children; } export function useAuthGate() { return { showPrivateSurfaces:true, phase:"authenticated", sessionAuthenticated:true }; }' }));
  await page.addInitScript(({ wallet, kind, hashes, declineSwapOnce, router }) => {
    // Built here: a function does not cross into the page.
    const receipt = (hash: string) => ({
      transactionHash: hash, status: '0x1', blockNumber: '0x10', blockHash: `0x${'c'.repeat(64)}`, gasUsed: '0x5208',
      cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', from: wallet, to: router, contractAddress: null,
      logs: [], logsBloom: `0x${'0'.repeat(512)}`, transactionIndex: '0x0', type: '0x2',
    });
    // wagmi reconnects the injected wallet it finds in its own storage.
    localStorage.setItem('wagmi.recentConnectorId', '"injected"');
    localStorage.setItem('wagmi.injected.connected', 'true');
    const sends: Array<{ data: string; at: number }> = [];
    let declined = false;
    Object.assign(window, { __walletSends: sends, __walletMethods: [] as string[], ethereum: {
      on() {}, removeListener() {},
      request: async ({ method, params }: { method: string; params?: Array<Record<string, string>> }) => {
        (window as unknown as { __walletMethods: string[] }).__walletMethods.push(method);
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet];
        if (method === 'wallet_getCapabilities' && kind === 'silent-capabilities') return {};
        if (method.startsWith('wallet_')) {
          throw Object.assign(new Error(`method [${method}] doesn't has corresponding handler`), { code: -32601 });
        }
        if (method === 'eth_sendTransaction') {
          const data = String(params?.[0]?.data ?? '');
          if (declineSwapOnce && !declined && data.startsWith('0x12345678')) {
            declined = true;
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          }
          sends.push({ data, at: Date.now() });
          return hashes[sends.length - 1];
        }
        // What the batch poller asks the wallet for, as Rabby forwards it.
        if (method === 'eth_getTransactionReceipt') return receipt(String(params?.[0]));
        throw new Error(`Fixture does not answer ${method}`);
      },
    } });
  }, { wallet: WALLET, kind, hashes: TX, declineSwapOnce: Boolean(options.declineSwapOnce), router: ROUTER });
  const state = {
    approvals: [] as Array<Record<string, unknown>>,
    records: [] as Array<Record<string, unknown>>,
    allowance: 0n,
    receiptReadAt: [] as Array<{ hash: string; at: number }>,
    allowanceReads: 0,
  };
  // The app's own Base transport: the allowance read and the wait for the
  // allowance to land.
  await page.route('https://mainnet.base.org/**', async (route) => {
    const body = route.request().postDataJSON() as { id: number; method: string; params: unknown[] } | Array<{ id: number; method: string; params: unknown[] }>;
    const answer = (call: { id: number; method: string; params: unknown[] }) => {
      if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: '0x2105' };
      if (call.method === 'eth_call') {
        // wagmi batches reads through Multicall3 unless told otherwise.
        state.allowanceReads += 1;
        const [tx] = call.params as [{ to: string; data: `0x${string}` }];
        const word = encodeAbiParameters([{ type: 'uint256' }], [state.allowance]);
        if (tx.to.toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11') return { jsonrpc: '2.0', id: call.id, result: word };
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
        const reads = (args?.[0] ?? []) as readonly unknown[];
        return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3',
          result: reads.map(() => ({ success: true, returnData: word })) }) };
      }
      if (call.method === 'eth_getTransactionReceipt') {
        const hash = String(call.params[0]);
        state.receiptReadAt.push({ hash, at: Date.now() });
        // The allowance has landed: the chain now holds it.
        state.allowance = AMOUNT;
        return { jsonrpc: '2.0', id: call.id, result: receiptOf(hash) };
      }
      if (call.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: call.id, result: '0x10' };
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `fixture: ${call.method}` } };
    };
    await route.fulfill({ json: Array.isArray(body) ? body.map(answer) : answer(body) });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { user: { id: 'fixture', address: WALLET, chainId: 8453 } } });
    if (path === '/api/route-intelligence/swap/blueprints/bp_1/approve' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.approvals.push(body);
      const steps = body.delivery === 'sequential';
      return route.fulfill({ json: {
        outcome: 'approved',
        lifecycle: 'approved',
        payload: {
          blueprintId: 'bp_1', blueprintHash: HASH, approvedCallsHash: HASH, chainId: '0x2105', from: WALLET,
          calls: [{ to: USDC, value: '0x0', data: ALLOWANCE_DATA }, { to: ROUTER, value: '0x0', data: SWAP_DATA }],
          atomicRequired: !steps,
          ...(steps ? { delivery: 'sequential' } : {}),
        },
        // The offer that made the old screen blame the sponsor; none for steps.
        sponsorship: steps ? null : { paymasterUrl: 'https://stills.lat/api/paymaster/sponsorship/fixture', context: { sponsorship: 'fixture' } },
      } });
    }
    if (path === '/api/route-intelligence/swap/blueprints/bp_1/submission' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.records.push(body);
      // The server's own answer shape; a recorded submission is still a pending proof.
      const status = String(body.status);
      const finalStatus = status === 'confirmed' ? 'completed' : status === 'failed' || status === 'cancelled' ? status : 'pending';
      return route.fulfill({ json: { outcome: 'recorded', lifecycle: status, proofId: 'proof_1', finalStatus } });
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

const walletSends = (page: Page) => page.evaluate(() => (window as unknown as { __walletSends: Array<{ data: string; at: number }> }).__walletSends);

test('a wallet with no batch methods swaps in two steps, the second only once the first has landed', async ({ page }) => {
  const state = await install(page, 'no-methods');
  await page.goto('/lending/fixture-draft');
  await expect(page.getByRole('status').filter({ hasText: /^This wallet sends one transaction at a time/ })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirmed onchain', exact: true })).toBeVisible();

  expect(state.approvals).toEqual([expect.objectContaining({ delivery: 'sequential' })]);
  const sends = await walletSends(page);
  expect(sends.map((send) => send.data)).toEqual([ALLOWANCE_DATA, SWAP_DATA]);
  // The swap was asked for only after the allowance's receipt was read.
  const landed = state.receiptReadAt.find((read) => read.hash === TX[0]);
  expect(landed && sends[1]!.at >= landed.at).toBe(true);
  // One batch id, viem's fallback format, for both hashes; then the confirmation.
  const [submitted, confirmed] = state.records;
  expect(submitted).toMatchObject({ status: 'submitted', transactionHashes: [TX[0], TX[1]] });
  expect(String(submitted!.batchId)).toMatch(new RegExp(`^${TX[0]}${TX[1]!.slice(2)}0{60}2105(5792){16}$`));
  expect(confirmed).toMatchObject({ status: 'confirmed', batchId: submitted!.batchId });
  await expect(page.getByText(/fee sponsored|Press again/)).toHaveCount(0);
});

test('a declined swap step leaves the allowance, and the next press sends only the swap', async ({ page }) => {
  const state = await install(page, 'no-methods', { declineSwapOnce: true });
  await page.goto('/lending/fixture-draft');
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /^The allowance for the exact amount is in place; the swap itself was not sent/ })).toBeVisible();
  expect(state.records).toEqual([expect.objectContaining({ status: 'cancelled', transactionHashes: [TX[0]] })]);

  const readsBefore = state.allowanceReads;
  await page.getByRole('button', { name: 'Cancelled in wallet — retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirmed onchain', exact: true })).toBeVisible();
  expect(state.allowanceReads).toBeGreaterThan(readsBefore);
  // No second allowance: the chain already holds one for the amount.
  expect((await walletSends(page)).map((send) => send.data)).toEqual([ALLOWANCE_DATA, SWAP_DATA]);
  expect(state.records.at(-1)).toMatchObject({ status: 'confirmed', transactionHashes: [TX[1]] });
});

test('a wallet whose batch fails as unsupported is offered the steps on the next press, and the sponsor is not blamed', async ({ page }) => {
  const state = await install(page, 'silent-capabilities');
  await page.goto('/lending/fixture-draft');
  await page.getByRole('button', { name: 'Confirm in your wallet', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /^This wallet could not send these calls together\. Nothing was sent\. Press again/ })).toBeVisible();
  await expect(page.getByText(/fee sponsored/)).toHaveCount(0);
  expect(state.approvals).toEqual([expect.not.objectContaining({ delivery: 'sequential' })]);
  expect(await walletSends(page)).toEqual([]);

  await page.getByRole('button', { name: 'Failed — retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirmed onchain', exact: true })).toBeVisible();
  expect(state.approvals.at(-1)).toMatchObject({ delivery: 'sequential' });
  expect((await walletSends(page)).map((send) => send.data)).toEqual([ALLOWANCE_DATA, SWAP_DATA]);
});
