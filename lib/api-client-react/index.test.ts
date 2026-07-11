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
    assert.ok(apiClient.useExecuteAction, 'useExecuteAction should be exported');
    assert.ok(apiClient.useDismissAction, 'useDismissAction should be exported');
    assert.ok(apiClient.useUpdateSettings, 'useUpdateSettings should be exported');
    assert.ok(apiClient.useUpdateMemory, 'useUpdateMemory should be exported');
    assert.ok(apiClient.useToggleProtocol, 'useToggleProtocol should be exported');
    assert.ok(apiClient.useLogin, 'useLogin should be exported');
    assert.ok(apiClient.useLogout, 'useLogout should be exported');
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
