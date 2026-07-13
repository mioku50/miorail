import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBaseAppEarly } from './detectBaseAppEarly';

test('T48a.1 detects Base App via user-agent regardless of casing', () => {
  assert.equal(detectBaseAppEarly({ userAgent: 'Mozilla/5.0 BaseApp/1.4' }), true);
  assert.equal(detectBaseAppEarly({ userAgent: 'Mozilla/5.0 baseapp/1.4' }), true);
  assert.equal(detectBaseAppEarly({ userAgent: 'CoinbaseWallet/32.1 (iPhone)' }), true);
  assert.equal(detectBaseAppEarly({ userAgent: 'cbwallet/9.0 Android' }), true);
});

test('T48a.2 detects Base App via the webview-only isBaseApp flag', () => {
  assert.equal(
    detectBaseAppEarly({ userAgent: 'Mozilla/5.0', ethereum: { isBaseApp: true } }),
    true,
  );
});

test('T48a.2 does NOT treat isCoinbaseWallet as a Base App signal (desktop extension sets it)', () => {
  // The desktop Coinbase Wallet extension sets isCoinbaseWallet=true; that must
  // not classify a normal browser as Base App, or baseAccount() sign-in is lost.
  assert.equal(
    detectBaseAppEarly({ userAgent: 'Mozilla/5.0', ethereum: { isCoinbaseWallet: true } }),
    false,
  );
  assert.equal(
    detectBaseAppEarly({
      userAgent: 'Mozilla/5.0',
      ethereum: { providers: [{ isMetaMask: true }, { isCoinbaseWallet: true }] },
    }),
    false,
  );
});

test('T48a.2 detects Base App via EIP-6963 providers[] isBaseApp fan-out', () => {
  assert.equal(
    detectBaseAppEarly({
      userAgent: 'Mozilla/5.0',
      ethereum: {
        providers: [{ isBaseApp: true }],
      },
    }),
    true,
  );
});

test('T48a.1 does not flag a normal desktop browser', () => {
  assert.equal(
    detectBaseAppEarly({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36',
    }),
    false,
  );
  assert.equal(
    detectBaseAppEarly({
      userAgent: 'Mozilla/5.0 Chrome/126.0',
      ethereum: { isMetaMask: true },
    }),
    false,
  );
  assert.equal(
    detectBaseAppEarly({
      userAgent: 'Mozilla/5.0 Chrome/126.0',
      ethereum: { providers: [{ isMetaMask: true }] },
    }),
    false,
  );
  assert.equal(detectBaseAppEarly({}), false);
  assert.equal(detectBaseAppEarly({ userAgent: 'Mozilla/5.0', ethereum: undefined }), false);
});
