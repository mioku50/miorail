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

  it('T58 route-proof hooks are exported with their bounded-polling constants', () => {
    assert.ok(apiClient.useReconcileRouteProof, 'useReconcileRouteProof should be exported');
    assert.ok(apiClient.useRouteProof, 'useRouteProof should be exported');
    assert.ok(apiClient.useRouteHistory, 'useRouteHistory should be exported');
    assert.ok(apiClient.useBoundedProofReconciliation, 'useBoundedProofReconciliation should be exported');
    assert.strictEqual(apiClient.MAX_PROOF_POLL_ATTEMPTS, 10);
    assert.strictEqual(apiClient.PROOF_POLL_INTERVAL_MS, 4000);
    assert.deepStrictEqual([...apiClient.PROOF_RECONCILE_RETRY_ATTEMPTS], [3, 6]);
    assert.deepStrictEqual(
      [...apiClient.PROOF_TERMINAL_FINAL_STATUSES],
      ['completed', 'partial_failure', 'failed', 'cancelled', 'reconciliation_required'],
    );
  });

  it('T58 reconcile mutation is pure: retry:false, re-validated response, no polling', () => {
    const source = apiClient.useReconcileRouteProof.toString();
    assert.ok(/retry:\s*false/.test(source) || /retry:\s*!1/.test(source), 'reconcile must never auto-retry');
    assert.ok(source.includes('RouteProofReconcileRequestV1Schema'), 'reconcile request must be schema-parsed');
    assert.ok(source.includes('RouteProofReconcileResponseV1Schema'), 'reconcile response must be re-validated');
    assert.ok(!source.includes('refetchInterval'), 'mutations must never poll');
    assert.ok(!/rpcUrl/i.test(source), 'the client must never supply an RPC URL');
  });

  it('T58 useRouteProof and useRouteHistory are non-polling, non-retrying reads', () => {
    for (const hook of [apiClient.useRouteProof, apiClient.useRouteHistory]) {
      const source = hook.toString();
      assert.ok(/retry:\s*false|retry:\s*!1/.test(source), 'reads must not auto-retry');
      assert.ok(/refetchInterval:\s*(false|!1)/.test(source), 'reads must default to no polling');
    }
    assert.ok(
      apiClient.useRouteProof.toString().includes('RouteProofGetResponseV1Schema'),
      'proof read must re-validate the response',
    );
    assert.ok(
      apiClient.useRouteHistory.toString().includes('RouteHistoryResponseV1Schema'),
      'history read must re-validate the response',
    );
  });

  it('T58 bounded reconciliation stops on terminal statuses and at the attempt cap', () => {
    const source = apiClient.useBoundedProofReconciliation.toString();
    assert.ok(source.includes('isTerminalProofFinalStatus'), 'polling must stop on a terminal finalStatus');
    assert.ok(source.includes('MAX_PROOF_POLL_ATTEMPTS'), 'polling must be capped by MAX_PROOF_POLL_ATTEMPTS');
    assert.ok(source.includes('PROOF_RECONCILE_RETRY_ATTEMPTS'), 're-reconcile must use the shared attempt list');
    assert.ok(source.includes('attemptsRef'), 'attempts must be counted through a ref');
    assert.ok(/return\s+(false|!1)/.test(source), 'the refetchInterval callback must be able to stop polling');
    assert.strictEqual(
      apiClient.isTerminalProofFinalStatus('completed') && apiClient.isTerminalProofFinalStatus('reconciliation_required'),
      true,
    );
    assert.strictEqual(apiClient.isTerminalProofFinalStatus('pending'), false);
    assert.strictEqual(apiClient.isTerminalProofFinalStatus(null), false);
  });

  it('T60 Intelligence Budget hooks are all exported', () => {
    assert.ok(apiClient.useIntelligenceBudget, 'useIntelligenceBudget should be exported');
    assert.ok(apiClient.useCreateIntelligenceBudget, 'useCreateIntelligenceBudget should be exported');
    assert.ok(apiClient.useUpdateIntelligenceBudget, 'useUpdateIntelligenceBudget should be exported');
    assert.ok(apiClient.useRevokeIntelligenceBudget, 'useRevokeIntelligenceBudget should be exported');
    assert.ok(apiClient.useSimulateWithBudget, 'useSimulateWithBudget should be exported');
    assert.ok(apiClient.deterministicBudgetRequestIdV1, 'deterministicBudgetRequestIdV1 should be exported');
  });

  it('T60 deterministicBudgetRequestIdV1 is pure and deterministic per (wallet, blueprintHash)', () => {
    const wallet = '0xAAA1111111111111111111111111111111111111';
    const blueprintHash = `0x${'2'.repeat(64)}`;
    const first = apiClient.deterministicBudgetRequestIdV1({ walletAddress: wallet, blueprintHash });
    const repeat = apiClient.deterministicBudgetRequestIdV1({ walletAddress: wallet.toLowerCase(), blueprintHash });
    const other = apiClient.deterministicBudgetRequestIdV1({ walletAddress: wallet, blueprintHash: `0x${'3'.repeat(64)}` });
    assert.strictEqual(first, repeat, 'same (wallet, blueprintHash) must always map to the same requestId');
    assert.notStrictEqual(first, other, 'a different blueprintHash must produce a different requestId');
    // Must satisfy SimulateWithBudgetRequestV1Schema's requestId regex + length.
    assert.ok(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(first));
    assert.ok(first.length <= 200);
  });

  it('T60 useSimulateWithBudget is a PLAIN POST — never signs, never x402, never wagmi, retry:false', () => {
    const source = apiClient.useSimulateWithBudget.toString();
    assert.ok(/retry:\s*false|retry:\s*!1/.test(source), 'simulate-with-budget must never auto-retry');
    assert.ok(!source.includes('signTypedData'), 'must never signTypedData');
    assert.ok(!source.includes('x402'), "must never touch x402");
    assert.ok(!source.includes('paidFetch'), 'must never use paidFetch');
    assert.ok(!/wagmi/i.test(source), 'must never touch wagmi');
    assert.ok(!/useSendCalls|useSignTypedData|walletClient/.test(source), 'must never call a wallet');
    assert.ok(source.includes('SimulateWithBudgetRequestV1Schema'), 'request must be schema-parsed');
    assert.ok(source.includes('SimulateWithBudgetResponseV1Schema'), 'response must be re-validated');
    assert.ok(source.includes('simulate-with-budget'), 'must POST the simulate-with-budget route');
    assert.ok(source.includes('deterministicBudgetRequestIdV1'), 'must derive a deterministic requestId by default');
  });

  it('T60 budget CRUD mutations are non-retrying and re-validate their responses', () => {
    for (const hook of [
      apiClient.useCreateIntelligenceBudget,
      apiClient.useUpdateIntelligenceBudget,
      apiClient.useRevokeIntelligenceBudget,
    ]) {
      const source = hook.toString();
      assert.ok(/retry:\s*false|retry:\s*!1/.test(source), 'budget mutations must never auto-retry');
      assert.ok(source.includes('IntelligenceBudgetResponseV1Schema'), 'budget response must be re-validated');
      assert.ok(source.includes("'intelligence-budget'") || source.includes('"intelligence-budget"'), 'must invalidate the budget query');
      assert.ok(!source.includes('signTypedData') && !source.includes('x402'), 'budget CRUD must never sign or x402');
    }
    assert.ok(/retry:\s*false|retry:\s*!1/.test(apiClient.useIntelligenceBudget.toString()), 'budget read must not auto-retry');
    assert.ok(
      apiClient.useIntelligenceBudget.toString().includes('IntelligenceBudgetResponseV1Schema'),
      'budget read must re-validate the response',
    );
  });

  it('T61 useEarnCompare is exported and is a PLAIN POST — never signs, never x402, never wagmi, retry:false', () => {
    assert.ok(apiClient.useEarnCompare, 'useEarnCompare should be exported');
    const source = apiClient.useEarnCompare.toString();
    assert.ok(/retry:\s*false|retry:\s*!1/.test(source), 'earn compare must never auto-retry');
    assert.ok(!source.includes('signTypedData'), 'must never signTypedData');
    assert.ok(!source.includes('x402'), 'must never touch x402');
    assert.ok(!source.includes('paidFetch'), 'must never use paidFetch');
    assert.ok(!/wagmi/i.test(source), 'must never touch wagmi');
    assert.ok(!/useSendCalls|useSignTypedData|walletClient/.test(source), 'must never call a wallet');
    assert.ok(source.includes('EarnCompareRequestV1Schema'), 'request must be schema-parsed');
    assert.ok(source.includes('EarnCompareResponseV1Schema'), 'response must be re-validated');
    assert.ok(source.includes('earn/compare'), 'must POST the earn/compare route');
  });

  it('T61 useEarnCompare reuses RoutePlanRequestIdentity: stable requestId on manual retry, rotates on message change', () => {
    const identity = new apiClient.RoutePlanRequestIdentity();
    const wallet = '0x1111111111111111111111111111111111111111' as const;
    const first = identity.resolve({ message: 'Deposit 500 USDC for yield', walletAddress: wallet });
    const retry = identity.resolve({ message: '  Deposit 500 USDC for yield  ', walletAddress: wallet });
    const changed = identity.resolve({ message: 'Deposit 250 USDC for yield', walletAddress: wallet });
    assert.strictEqual(retry, first);
    assert.notStrictEqual(changed, first);
  });
});
