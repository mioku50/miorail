import { test, describe, mock } from 'node:test';

import assert from 'node:assert';
import { createToolAggregatorForUser, selectBaseMcpRuntimeTools, settingsAPI } from '../src/factory.js';
import { NativeToolProvider } from '../src/native.js';
import { MockCoinGeckoProvider, RealCoinGeckoProvider, MockMoralisProvider, RealMoralisProvider } from '@mioagent/data-providers';
import { classifyDynamicBaseMcpTools } from '../src/dynamic_base_mcp.js';

describe('createToolAggregatorForUser', () => {

    test('read-only Agent runtime excludes swap and every transaction-capable Base MCP tool', () => {
        const discovered = classifyDynamicBaseMcpTools([
            { name: 'get_portfolio', description: 'Read balances' },
            { name: 'moonwell_get_markets', description: 'Read markets' },
            { name: 'swap_tokens', description: 'Swap tokens' },
            { name: 'morpho_prepare_deposit', description: 'Prepare deposit' },
        ]);
        const selected = selectBaseMcpRuntimeTools(discovered, true);
        assert.deepStrictEqual(selected.map((tool) => tool.name), ['get_portfolio', 'moonwell_get_markets']);
        assert.strictEqual(selected.every((tool) => tool.capability === 'read_only'), true);
    });

    test('user-confirmed swap selection adds only Base MCP swap to the read inventory', () => {
        const discovered = classifyDynamicBaseMcpTools([
            { name: 'get_portfolio', description: 'Read balances' },
            { name: 'swap', description: 'Swap tokens' },
            { name: 'morpho_prepare_deposit', description: 'Prepare deposit' },
        ]);
        const selected = selectBaseMcpRuntimeTools(discovered, true, true);
        assert.deepStrictEqual(selected.map((tool) => tool.name), ['get_portfolio', 'swap']);
    });

    test('protected direct-send selection adds exact Base MCP send only when explicitly enabled', () => {
        const discovered = classifyDynamicBaseMcpTools([
            { name: 'get_portfolio', description: 'Read balances' },
            { name: 'send', description: 'Send a token' },
            { name: 'send_calls', description: 'Generic call batch' },
            { name: 'morpho_prepare_deposit', description: 'Prepare deposit' },
        ]);
        const selected = selectBaseMcpRuntimeTools(discovered, true, false, true);
        assert.deepStrictEqual(selected.map((tool) => tool.name), ['get_portfolio', 'send']);
    });

    test('returns mock providers when toggles are missing or false', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: {}
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        const nativeToolProvider = aggregator['providers'].get('native') as NativeToolProvider;

        assert.ok(nativeToolProvider['coinGecko'] instanceof MockCoinGeckoProvider);
        assert.ok(nativeToolProvider['moralis'] instanceof MockMoralisProvider);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });

    test('returns real CoinGeckoProvider when enabled', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { coingecko: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        const nativeToolProvider = aggregator['providers'].get('native') as NativeToolProvider;

        assert.ok(nativeToolProvider['coinGecko'] instanceof RealCoinGeckoProvider);
        assert.ok(nativeToolProvider['moralis'] instanceof MockMoralisProvider);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });

    test('returns real MoralisProvider when enabled and key exists', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { moralis: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async (userId: string, keyName: string) => {
            if (keyName === 'moralis_api_key') return 'fake-moralis-key';
            return null;
        });

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        const nativeToolProvider = aggregator['providers'].get('native') as NativeToolProvider;

        assert.ok(nativeToolProvider['moralis'] instanceof RealMoralisProvider);
        assert.strictEqual((nativeToolProvider['moralis'] as RealMoralisProvider)['apiKey'], 'fake-moralis-key');

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });

    test('returns mock MoralisProvider when enabled but key missing', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { moralis: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        const nativeToolProvider = aggregator['providers'].get('native') as NativeToolProvider;

        assert.ok(nativeToolProvider['moralis'] instanceof MockMoralisProvider);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });

    test('missing keys do not leak secrets, fail silently to mock', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { moralis: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => {
            throw new Error('Database connection failed while fetching secret');
        });

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        const nativeToolProvider = aggregator['providers'].get('native') as NativeToolProvider;

        assert.ok(nativeToolProvider['moralis'] instanceof MockMoralisProvider);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });
});
