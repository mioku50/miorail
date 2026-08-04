import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, '..', 'src', 'console', 'console.css'), 'utf8');

// ---------------------------------------------------------------------------
// T70 §6/§9.10 — secondary text has to be readable.
//
// This is asserted against the stylesheet rather than a screenshot because it
// is arithmetic, and because the failure is invisible to every other kind of
// test: the markup was correct, the copy was correct, the words were simply
// too dark to read. On #07070b, --dim measured 2.07:1 and --faint 3.26:1 —
// both below the 4.5:1 WCAG AA needs for body text, and --dim below even the
// 3:1 that large or incidental text gets.
//
// The palette itself is untouched. Only the alphas moved, so the dark identity
// and the blue/violet accent are exactly what they were.
// ---------------------------------------------------------------------------

/** WCAG 2.1 relative luminance. */
function luminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: readonly [number, number, number], background: readonly [number, number, number]): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

function hex(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  assert.ok(match, `not a hex colour: ${value}`);
  const digits = match[1]!;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

/** Composites a token over its background, which is what the eye actually sees:
 * an rgba() text colour is not its own nominal value. */
function resolve(value: string, background: readonly [number, number, number]): [number, number, number] {
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(value.trim());
  if (!rgba) return hex(value);
  const alpha = Number.parseFloat(rgba[4]!);
  return [1, 2, 3].map((index) => {
    const channel = Number.parseInt(rgba[index]!, 10);
    return Math.round(channel * alpha + background[index - 1]! * (1 - alpha));
  }) as [number, number, number];
}

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} is not in console.css`);
  return css.slice(start, css.indexOf('\n}', start));
}

function token(selector: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(block(selector));
  assert.ok(match, `--${name} is not defined in ${selector}`);
  return match[1]!.trim();
}

/**
 * The floor for each token, and what it is for.
 *
 * `dim` is 3:1 rather than 4.5:1 because after T70 it carries only genuinely
 * de-emphasised labels — a switched-off adapter, a separator. Everything that
 * is a sentence a user has to READ (empty states, notes, drawer metadata,
 * status values) was moved onto `faint`, which is held to the body-text bar.
 */
const FLOOR_V1 = { ink: 7, muted: 4.5, faint: 4.5, dim: 3 } as const;

describe('secondary text is readable in both themes', () => {
  for (const [theme, selector] of [
    ['dark', ':root'],
    ['light', '[data-theme="light"]'],
  ] as const) {
    const background = hex(token(selector, 'bg'));

    for (const [name, floor] of Object.entries(FLOOR_V1)) {
      test(`${theme}: --${name} clears ${floor}:1`, () => {
        const ratio = contrast(resolve(token(selector, name), background), background);
        assert.ok(
          ratio >= floor,
          `--${name} is ${ratio.toFixed(2)}:1 against --bg, below the ${floor}:1 floor`,
        );
      });
    }
  }

  test('the check would actually have caught the old values', () => {
    // A guard on the guard. If `resolve` ever stopped compositing alpha, every
    // assertion above would pass on any value at all.
    const background = hex('#07070b');
    assert.ok(contrast(resolve('rgba(243,244,250,.26)', background), background) < 3, 'the old --dim now passes');
    assert.ok(contrast(resolve('rgba(243,244,250,.38)', background), background) < 4.5, 'the old --faint now passes');
  });
});

describe('the text that has to be read is not on the dimmest token', () => {
  /** The declaration body of the first rule whose selector matches. */
  function rule(pattern: RegExp): string {
    const matcher = /([^{}]+)\{([^{}]*)\}/g;
    for (let match = matcher.exec(css); match; match = matcher.exec(css)) {
      if (pattern.test(match[1] ?? '')) return match[2] ?? '';
    }
    return '';
  }

  for (const [what, selector] of [
    // Every one of these is prose a user is expected to read, and every one of
    // them was on --dim before T70.
    ['empty states', /\.mio-console \.empty\s*$/],
    ['small notes', /\.mio-console \.lnote\s*$/],
    ['drawer item metadata', /\.mio-console \.item \.m\s*$/],
    ['drawer section headings', /\.mio-console \.sechead\s*$/],
    ['panel subtitles', /\.mio-console \.ph \.sub\s*$/],
    ['value subtitles', /\.mio-console \.subv\s*$/],
    ['step labels', /\.mio-console \.st \.n\s*$/],
  ] as const) {
    test(`${what} use --faint or better`, () => {
      const body = rule(selector);
      assert.ok(body, `no rule matched ${selector}`);
      assert.ok(!/color:\s*var\(--dim\)/.test(body), `${what} are still on --dim`);
    });
  }

  test('a disabled nav entry explains itself in text', () => {
    // §6 — "Disabled-состояние должно объясняться текстом, а не только низким
    // контрастом." The rule exists so the reason wraps instead of being clipped
    // to one line by the flex row it inherits.
    assert.match(css, /\.item\.off \.m \{[^}]*white-space: normal/);
    assert.match(css, /\.item\.off \.m \{[^}]*color: var\(--faint\)/);
  });
});

describe('the visual identity is unchanged', () => {
  test('the accent gradient and both brand colours are exactly what they were', () => {
    assert.match(block(':root'), /--blue: #6aa9ff; --violet: #a98bff;/);
    assert.match(block(':root'), /--grad: linear-gradient\(120deg,#6aa9ff,#8e9bff 48%,#b98bff\)/);
    assert.match(block(':root'), /--bg: #07070b;/);
    assert.match(block('[data-theme="light"]'), /--blue: #0000ff; --violet: #7b3fe4;/);
  });
});
