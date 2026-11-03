import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PHONE_VIEWPORT_V1, TABLET_VIEWPORT_V1, viewportForScreenV1 } from './phoneScale';

test('phones in either orientation draw at three quarters, tablets and desktops at full size', () => {
  for (const screen of [{ width: 393, height: 852 }, { width: 852, height: 393 }, { width: 320, height: 568 }, { width: 412, height: 915 }]) {
    assert.equal(viewportForScreenV1(screen), PHONE_VIEWPORT_V1, `${screen.width}x${screen.height}`);
  }
  for (const screen of [{ width: 744, height: 1133 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 600, height: 960 }]) {
    assert.equal(viewportForScreenV1(screen), TABLET_VIEWPORT_V1, `${screen.width}x${screen.height}`);
  }
});

test('index.html asks for the phone size itself, so it holds from the first paint', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.equal(html.match(/<meta name="viewport" content="([^"]*)"/)?.[1], PHONE_VIEWPORT_V1);
});
