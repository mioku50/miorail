import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_PARTNER_HOSTS, PartnerHostNotAllowlistedError, partnerFetch } from './httpAllowlist.js';

test('partnerFetch calls through for an allowlisted host and always sets an abort timeout', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;

  const response = await partnerFetch('https://api.moonwell.fi/v1/markets?chain=base', {}, { fetchImpl });
  assert.equal(await response.text(), 'ok');
  assert.equal(capturedUrl, 'https://api.moonwell.fi/v1/markets?chain=base');
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('partnerFetch rejects a non-allowlisted host before any network call', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response('');
  }) as typeof fetch;

  await assert.rejects(
    () => partnerFetch('https://evil.example.com/steal', {}, { fetchImpl }),
    PartnerHostNotAllowlistedError,
  );
  assert.equal(called, false);
});

test('partnerFetch honors a custom timeoutMs', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    capturedInit = init;
    return new Response('ok');
  }) as typeof fetch;

  await partnerFetch('https://trade-api.gateway.uniswap.org/v1/quote', {}, { fetchImpl, timeoutMs: 1234 });
  assert.ok(capturedInit?.signal instanceof AbortSignal);
});

test('ALLOWED_PARTNER_HOSTS covers exactly the sanctioned partner hosts', () => {
  assert.deepEqual([...ALLOWED_PARTNER_HOSTS], [
    'api.moonwell.fi',
    'trade-api.gateway.uniswap.org',
    'liquidity.api.uniswap.org',
    'mcp.morpho.org',
  ]);
});
