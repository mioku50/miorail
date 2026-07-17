import { describe, it } from 'node:test';
import assert from 'node:assert';
import { QueryClient } from '@tanstack/react-query';
import type { ConfigureAutonomyResponse } from '@mioagent/api-spec';
import * as apiClient from './index.js';

describe('api-client-react', () => {
  it('should export query and mutation hooks', () => {
    assert.ok(apiClient.useSession, 'useSession should be exported');
    assert.ok(apiClient.useChatHistory, 'useChatHistory should be exported');
    assert.ok(apiClient.useActionsFeed, 'useActionsFeed should be exported');
    assert.ok(apiClient.useSettings, 'useSettings should be exported');
    assert.ok(apiClient.useMemory, 'useMemory should be exported');
    assert.ok(apiClient.useProtocols, 'useProtocols should be exported');
    assert.ok(apiClient.usePortfolio, 'usePortfolio should be exported');

    assert.ok(apiClient.useSendMessage, 'useSendMessage should be exported');
    assert.ok(apiClient.useReconcileBaseMcpTransactions, 'useReconcileBaseMcpTransactions should be exported');
    assert.ok(apiClient.useExecuteAction, 'useExecuteAction should be exported');
    assert.ok(apiClient.useDismissAction, 'useDismissAction should be exported');
    assert.ok(apiClient.useUpdateSettings, 'useUpdateSettings should be exported');
    assert.ok(apiClient.useUpdateMemory, 'useUpdateMemory should be exported');
    assert.ok(apiClient.useToggleProtocol, 'useToggleProtocol should be exported');
    assert.ok(apiClient.useLogin, 'useLogin should be exported');
    assert.ok(apiClient.useLogout, 'useLogout should be exported');
    assert.ok(apiClient.usePrepareSwapBlueprint, 'usePrepareSwapBlueprint should be exported');
    assert.ok(apiClient.useApproveSwapBlueprint, 'useApproveSwapBlueprint should be exported');
    assert.ok(apiClient.useRecordBlueprintSubmission, 'useRecordBlueprintSubmission should be exported');
  });

  it('T57 blueprint hooks are pure non-retrying mutations without polling or client-supplied calls', () => {
    for (const hook of [apiClient.useApproveSwapBlueprint, apiClient.useRecordBlueprintSubmission]) {
      const source = hook.toString();
      assert.ok(/retry:\s*false/.test(source), 'blueprint hooks must never auto-retry');
      assert.ok(!source.includes('useCallsStatus'), 'blueprint hooks must not poll wallet status');
      assert.ok(!source.includes('refetchInterval'), 'blueprint hooks must not poll');
    }
    const approveSource = apiClient.useApproveSwapBlueprint.toString();
    assert.ok(approveSource.includes('SwapBlueprintApproveResponseV1Schema'), 'approve response must be re-validated');
    const submissionSource = apiClient.useRecordBlueprintSubmission.toString();
    assert.ok(
      submissionSource.includes('SwapBlueprintSubmissionResponseV1Schema'),
      'submission response must be re-validated',
    );
    assert.ok(!/calls:/.test(submissionSource), 'the submission hook must never send calls');
  });

  it('keeps one request ID for a manual retry and rotates it after material changes', () => {
    const identity = new apiClient.RoutePlanRequestIdentity();
    const wallet = '0x1111111111111111111111111111111111111111' as const;
    const first = identity.resolve({ message: 'Swap 100 USDC to ETH', walletAddress: wallet });
    const retry = identity.resolve({ message: '  Swap 100 USDC to ETH  ', walletAddress: wallet });
    const changed = identity.resolve({ message: 'Swap 200 USDC to ETH', walletAddress: wallet });
    const explicit = identity.resolve({ message: 'Swap 200 USDC to ETH', walletAddress: wallet, requestId: 'manual-request-1' });

    assert.strictEqual(retry, first);
    assert.notStrictEqual(changed, first);
    assert.strictEqual(explicit, 'manual-request-1');
  });

  it('keeps one swap-prepare request ID per (wallet, routeRun, card, candidate) and rotates on change', () => {
    const identity = new apiClient.SwapPrepareRequestIdentity();
    const wallet = '0x1111111111111111111111111111111111111111' as const;
    const routeRunId = 'run-1';
    const routeCardHash = `0x${'1'.repeat(64)}`;
    const selectedCandidateHash = `0x${'2'.repeat(64)}`;

    const first = identity.resolve({ walletAddress: wallet, routeRunId, routeCardHash, selectedCandidateHash });
    const retry = identity.resolve({ walletAddress: wallet, routeRunId, routeCardHash, selectedCandidateHash });
    const changedCandidate = identity.resolve({
      walletAddress: wallet,
      routeRunId,
      routeCardHash,
      selectedCandidateHash: `0x${'3'.repeat(64)}`,
    });
    const explicit = identity.resolve({
      walletAddress: wallet,
      routeRunId,
      routeCardHash,
      selectedCandidateHash,
      requestId: 'manual-prepare-1',
    });

    assert.strictEqual(retry, first);
    assert.notStrictEqual(changedCandidate, first);
    assert.strictEqual(explicit, 'manual-prepare-1');
  });

  it('publishes configured autonomy state synchronously before refetch', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['autonomy'], {
      status: 'unconfigured',
      sessionKey: { source: 'missing', blockedReasons: ['autonomy_policy_missing'] },
    });
    const state = {
      status: 'configured',
      source: 'database',
      sessionKey: {
        status: 'configured',
        source: 'database',
        dailyLimitUsdc: '1',
        maxPerActionUsdc: '0.2',
        whitelist: ['0x1111111111111111111111111111111111111111'],
        mainnetOptIn: false,
        executionReady: false,
        blockedReasons: ['mainnet_readonly'],
      },
    } as ConfigureAutonomyResponse['state'];

    const refresh = apiClient.syncConfiguredAutonomyState(queryClient, { success: true, state });
    assert.deepStrictEqual(queryClient.getQueryData<ConfigureAutonomyResponse['state']>(['autonomy']), state);
    assert.deepStrictEqual(
      queryClient.getQueryData<ConfigureAutonomyResponse['state']>(['autonomy'])?.sessionKey.blockedReasons,
      ['mainnet_readonly'],
    );
    await refresh;
  });
});
