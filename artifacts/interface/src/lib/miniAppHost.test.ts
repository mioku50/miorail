import assert from 'node:assert/strict';
import test from 'node:test';
import { castEmbedsV1, mayBeMiniAppFrameV1, miniAppFrameProbeV1 } from './miniAppHost';

test('only a frame can be a mini app: a browser tab never loads the SDK', () => {
  assert.equal(mayBeMiniAppFrameV1({ reactNativeWebView: false, framed: false }), false);
  // Farcaster on a phone: a React Native WebView.
  assert.equal(mayBeMiniAppFrameV1({ reactNativeWebView: true, framed: false }), true);
  // Farcaster on the web: an iframe of its own page.
  assert.equal(mayBeMiniAppFrameV1({ reactNativeWebView: false, framed: true }), true);
});

test('the probe reads a tab, a phone webview and a cross-origin frame for what they are', () => {
  const tab = { self: null as unknown, top: null as unknown };
  tab.self = tab;
  tab.top = tab;
  assert.deepEqual(miniAppFrameProbeV1(tab as unknown as Window), { reactNativeWebView: false, framed: false });

  const webview = { self: null as unknown, top: null as unknown, ReactNativeWebView: { postMessage() {} } };
  webview.self = webview;
  webview.top = webview;
  assert.deepEqual(miniAppFrameProbeV1(webview as unknown as Window), { reactNativeWebView: true, framed: false });

  const framed = {
    self: {},
    get top(): Window {
      throw new Error('Blocked a frame with origin "https://miorail.xyz" from accessing a cross-origin frame.');
    },
  };
  assert.deepEqual(miniAppFrameProbeV1(framed as unknown as Window), { reactNativeWebView: false, framed: true });
});

test('embeds go to Farcaster as the tuple it takes: none, one or two', () => {
  assert.deepEqual(castEmbedsV1([]), []);
  assert.deepEqual(castEmbedsV1(['https://miorail.xyz/stocks']), ['https://miorail.xyz/stocks']);
  assert.deepEqual(castEmbedsV1(['a', 'b', 'c']), ['a', 'b']);
});
