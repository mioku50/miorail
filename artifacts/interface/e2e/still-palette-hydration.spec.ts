import { expect, test } from '@playwright/test';

const DAY = '2026-10-29T12:00:00Z';
const NIGHT = '2026-10-29T22:00:00Z';
const DUSK = '2026-10-29T18:00:00Z';

for (const client of [
  { label: 'night', time: NIGHT, palette: 'night', background: 'rgb(11, 15, 46)' },
  { label: 'day', time: DAY, palette: 'day', background: 'rgb(246, 249, 255)' },
  { label: 'dusk', time: DUSK, palette: 'day', background: 'rgb(246, 249, 255)' },
]) {
  test(`prerendered Still page hydrates into the browser's Berlin ${client.label}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      // This isolated HTML fixture never needs Vite's HMR connection.
      // Chromium may block that dev-only socket under local-network rules.
      const text = message.text();
      const devSocket = text.startsWith("WebSocket connection to 'ws://127.0.0.1:5187/") || text.startsWith('[vite] failed to connect to websocket.');
      if (message.type() === 'error' && !devSocket) errors.push(text);
    });
    await page.route('**/__palette-hydration', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><div id="palette-fixture"></div></body></html>' }));
    await page.goto('/__palette-hydration');
    await page.evaluate(async ({ serverTime, clientTime }) => {
      // The intercepted HTML is intentionally empty, so install Vite's
      // ordinary development preamble before loading its compiled modules.
      const refreshPath = '/@react-refresh';
      const { default: refresh } = await import(/* @vite-ignore */ refreshPath);
      refresh.injectIntoGlobalHook(window);
      Object.assign(window, { $RefreshReg$: () => {}, $RefreshSig$: () => (type: unknown) => type, __vite_plugin_react_preamble_installed__: true });
      // Vite compiles the real hook, React and CSS; no module or palette mock.
      const modulePath = '/e2e/fixtures/still-palette-hydration.tsx';
      const { hydratePalette } = await import(/* @vite-ignore */ modulePath);
      const fixture = hydratePalette(serverTime, clientTime);
      Object.assign(window, { __stillPaletteFixture: fixture });
    }, { serverTime: DAY, clientTime: client.time });
    await expect(page.locator('#palette-fixture')).toHaveAttribute('data-server-sky', 'day');
    await expect(page.locator('main')).toHaveAttribute('data-sky', client.palette);
    await expect(page.locator('main')).toHaveCSS('background-color', client.background);
    // After hydration the same mounted page must follow later clock changes.
    await page.evaluate(at => (window as unknown as { __stillPaletteFixture: { update: (at: string) => void } }).__stillPaletteFixture.update(at), client.palette === 'night' ? DAY : NIGHT);
    await expect(page.locator('main')).toHaveAttribute('data-sky', client.palette === 'night' ? 'day' : 'night');
    await expect(page.locator('main')).toHaveCSS('background-color', client.palette === 'night' ? 'rgb(246, 249, 255)' : 'rgb(11, 15, 46)');
    expect(errors).toEqual([]);
  });
}