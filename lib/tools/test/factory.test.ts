import { test, describe, mock } from 'node:test';

import assert from 'node:assert';
import { createToolAggregatorForUser, selectBaseMcpRuntimeTools, settingsAPI } from '../src/factory.js';
import { NativeToolProvider } from '../src/native.js';
import { UniswapQuoteToolProvider } from '../src/uniswap_quote.js';
import { RealCoinGeckoProvider, RealMoralisProvider } from '@mioagent/data-providers';
import { classifyDynamicBaseMcpTools } from '../src/dynamic_base_mcp.js';

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe('createToolAggregatorForUser Moonwell registration', () => {
    test('registers the Moonwell HTTP provider outside Sepolia when requested', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        const previousChainEnv = process.env.CHAIN_ENV;
        process.env.CHAIN_ENV = 'mainnet';
        try {
            const aggregator = await createToolAggregatorForUser('u1', 'secret', { includeMoonwell: true });
            assert.ok(aggregator['providers'].has('moonwell-http'));
        } finally {
            process.env.CHAIN_ENV = previousChainEnv;
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });

    test('does not register Moonwell on Sepolia even when requested', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        const previousChainEnv = process.env.CHAIN_ENV;
        process.env.CHAIN_ENV = 'sepolia';
        try {
            const aggregator = await createToolAggregatorForUser('u1', 'secret', { includeMoonwell: true });
            assert.equal(aggregator['providers'].has('moonwell-http'), false);
        } finally {
            process.env.CHAIN_ENV = previousChainEnv;
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });

    test('does not register Moonwell when the protocol toggle is disabled', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: { moonwell: false } }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        const previousChainEnv = process.env.CHAIN_ENV;
        process.env.CHAIN_ENV = 'mainnet';
        try {
            const aggregator = await createToolAggregatorForUser('u1', 'secret', { includeMoonwell: true });
            assert.equal(aggregator['providers'].has('moonwell-http'), false);
        } finally {
            process.env.CHAIN_ENV = previousChainEnv;
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });

    test('does not register Moonwell when not requested by the caller', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        const previousChainEnv = process.env.CHAIN_ENV;
        process.env.CHAIN_ENV = 'mainnet';
        try {
            const aggregator = await createToolAggregatorForUser('u1', 'secret', {});
            assert.equal(aggregator['providers'].has('moonwell-http'), false);
        } finally {
            process.env.CHAIN_ENV = previousChainEnv;
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });
});

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

    test('does not register native tools when real providers are disabled', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: {}
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        assert.equal(aggregator['providers'].has('native'), false);

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
        assert.equal(nativeToolProvider['moralis'], undefined);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });

    test('returns real MoralisProvider when enabled and key exists', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { moralis: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async (_userId: string, keyName: string) => {
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

    test('does not register Moralis tools when enabled but key is missing', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { moralis: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        assert.equal(aggregator['providers'].has('native'), false);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });

    test('T48b: in mcp mode (default), Uniswap quote registration resolves UNISWAP_MCP_GATEWAY_KEY and never requires UNISWAP_API_KEY', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        try {
            await withEnv({ BASE_MCP_PLUGIN_MODE: undefined, UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: 'gateway-secret' }, async () => {
                const aggregator = await createToolAggregatorForUser('u1', 'secret', { includeUniswapQuote: true });
                const provider = aggregator['providers'].get('uniswap-quote') as UniswapQuoteToolProvider;
                assert.ok(provider);
                assert.equal((await provider.listTools()).length, 1);
            });
        } finally {
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });

    test('T48b: registration does not crash or fall back to a fake/mocked provider when no credential is configured in mcp mode', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        try {
            await withEnv({ BASE_MCP_PLUGIN_MODE: undefined, UNISWAP_API_KEY: undefined, UNISWAP_MCP_GATEWAY_KEY: undefined }, async () => {
                const aggregator = await createToolAggregatorForUser('u1', 'secret', { includeUniswapQuote: true });
                const provider = aggregator['providers'].get('uniswap-quote') as UniswapQuoteToolProvider;
                assert.ok(provider);
                assert.deepEqual(await provider.listTools(), []);
            });
        } finally {
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });

    test('T48b: direct mode falls back to UNISWAP_API_KEY and ignores UNISWAP_MCP_GATEWAY_KEY', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({ protocolToggles: {} }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => null);
        try {
            await withEnv({ BASE_MCP_PLUGIN_MODE: 'direct', UNISWAP_API_KEY: 'direct-secret', UNISWAP_MCP_GATEWAY_KEY: undefined }, async () => {
                const aggregator = await createToolAggregatorForUser('u1', 'secret', { includeUniswapQuote: true });
                const provider = aggregator['providers'].get('uniswap-quote') as UniswapQuoteToolProvider;
                assert.equal((await provider.listTools()).length, 1);
            });
        } finally {
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    });

    test('credential read failure leaves Moralis unavailable without substitute data', async () => {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            protocolToggles: { moralis: true }
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => {
            throw new Error('Database connection failed while fetching secret');
        });

        const aggregator = await createToolAggregatorForUser('u1', 'secret');
        assert.equal(aggregator['providers'].has('native'), false);

        mockGetSettings.mock.restore();
        mockGetDecryptedKey.mock.restore();
    });
});

// ---------------------------------------------------------------------------
// T74: `baseMcpOnly` is a boundary, not a convenience.
//
// The Base MCP console exists so that other people's tools and Miorail's
// measured routers are never in the same thread. That guarantee is only worth
// something if it survives the next provider somebody adds to this factory —
// which is why the switch suppresses everything rather than the caller passing
// the right combination of `include*: false`.
// ---------------------------------------------------------------------------
describe('createToolAggregatorForUser baseMcpOnly', () => {
    async function aggregatorWithEverythingRequested(options: Record<string, unknown>) {
        const mockGetSettings = mock.method(settingsAPI, 'getUserSettings', async () => ({
            // Every toggle a user could have turned on.
            protocolToggles: { coingecko: true, moralis: true, morpho: true, uniswap: true, moonwell: true },
        }));
        const mockGetDecryptedKey = mock.method(settingsAPI, 'getDecryptedKey', async () => 'moralis-key');
        const previousChainEnv = process.env.CHAIN_ENV;
        process.env.CHAIN_ENV = 'mainnet';
        try {
            return await createToolAggregatorForUser('u1', 'secret', {
                includeMorphoReadOnly: true,
                includeUniswapQuote: true,
                includeMoonwell: true,
                ...options,
            });
        } finally {
            process.env.CHAIN_ENV = previousChainEnv;
            mockGetSettings.mock.restore();
            mockGetDecryptedKey.mock.restore();
        }
    }

    test('registers no partner or native provider, however loudly they were requested', async () => {
        const aggregator = await aggregatorWithEverythingRequested({ baseMcpOnly: true });
        const registered = [...(aggregator['providers'] as Map<string, unknown>).keys()];
        assert.deepEqual(registered.filter((id) => !id.startsWith('base-mcp')), []);
    });

    test('without the switch the same request registers all of them', async () => {
        // The control: this is what the console would have inherited if the
        // separation were left to the caller.
        const aggregator = await aggregatorWithEverythingRequested({});
        const registered = [...(aggregator['providers'] as Map<string, unknown>).keys()];
        for (const expected of ['native', 'morpho-mcp', 'uniswap-quote', 'moonwell-http']) {
            assert.ok(registered.includes(expected), `${expected} should be registered without baseMcpOnly`);
        }
    });

    test('baseMcpOnly implies read-only whatever the swap and send flags say', async () => {
        // A user-confirmed transaction tool in a console with no Route Card is
        // exactly the mixing this separates. `selectBaseMcpRuntimeTools` is
        // where that filter lands, so assert it directly.
        const tools = classifyDynamicBaseMcpTools([
            { name: 'get_portfolio', description: 'read', inputSchema: {} },
            { name: 'swap', description: 'swap tokens', inputSchema: {} },
        ]);
        const readOnly = selectBaseMcpRuntimeTools(tools, true, false, false);
        assert.deepEqual(readOnly.map((tool) => tool.name), ['get_portfolio']);
    });
});
