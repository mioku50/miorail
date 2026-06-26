import { test, describe, mock } from 'node:test';

import assert from 'node:assert';
import { createToolAggregatorForUser, settingsAPI } from '../src/factory.js';
import { NativeToolProvider } from '../src/native.js';
import { MockCoinGeckoProvider, RealCoinGeckoProvider, MockMoralisProvider, RealMoralisProvider } from '@mioagent/data-providers';

describe('createToolAggregatorForUser', () => {

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
