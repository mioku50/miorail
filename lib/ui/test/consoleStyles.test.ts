import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const consoleDir = path.join(here, '..', 'src', 'console');
const css = readFileSync(path.join(consoleDir, 'console.css'), 'utf8');

// ---------------------------------------------------------------------------
// Every console class must have a rule.
//
// This exists because the NFT panels shipped with an invented class vocabulary
// — `nft-card`, `nft-row`, `nft-identity` — that no stylesheet ever defined.
// Every unit test passed: the components rendered the right TEXT, in the right
// order, with the right copy. They just had no layout, so a Route Card reached
// production as a wall of run-together words.
//
// Rendering tests assert what a panel SAYS. This asserts that it can be read.
// ---------------------------------------------------------------------------

/** Classes with a rule in console.css. */
const defined = new Set(css.match(/\.[A-Za-z][A-Za-z0-9_-]*/g)?.map((selector) => selector.slice(1)) ?? []);

/**
 * Classes that legitimately come from somewhere else.
 *
 * Kept deliberately tiny and explicit: an allowlist is how this guard would
 * quietly stop working. `mio-console` is the scope root the host applies, and
 * `mini` is the miniapp's modifier on it.
 */
const EXTERNAL_V1 = new Set(['mio-console', 'mini']);

function consoleSources(): { file: string; source: string }[] {
  return readdirSync(consoleDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ file: name, source: readFileSync(path.join(consoleDir, name), 'utf8') }));
}

/** Static class tokens in a file. Interpolations are blanked out first, so
 * `pill ${tone}` contributes `pill` and nothing invented. */
function classTokens(source: string): string[] {
  const tokens: string[] = [];
  const pattern = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    tokens.push(...raw.split(/\s+/).filter(Boolean));
  }
  return tokens;
}

describe('every console class has a stylesheet rule', () => {
  test('no panel invents a class vocabulary nobody styled', () => {
    const orphans: string[] = [];
    for (const { file, source } of consoleSources()) {
      for (const token of new Set(classTokens(source))) {
        if (defined.has(token) || EXTERNAL_V1.has(token)) continue;
        orphans.push(`${file}: .${token}`);
      }
    }
    assert.deepEqual(orphans, [], `these classes render as unstyled text:\n${orphans.join('\n')}`);
  });

  test('the NFT panels reuse the console vocabulary rather than their own', () => {
    const source = readFileSync(path.join(consoleDir, 'NftPanels.tsx'), 'utf8');
    // The panels are built from the same pieces every other panel uses.
    for (const shared of ['panel', 'ph', 'pb', 'qrow', 'cardrow', 'scorerow', 'pill', 'btn']) {
      assert.ok(classTokens(source).includes(shared), `NftPanels must use the shared .${shared}`);
    }
    // Only the image slot is new, because nothing else on the console shows one.
    const own = new Set(classTokens(source).filter((token) => token.startsWith('nft')));
    assert.deepEqual([...own].sort(), ['nftmedia', 'nftmedia-ph', 'nftrow']);
  });

  test('the media placeholder and its hatching are both styled', () => {
    // The blocked-image state is the one a policy-restricted deployment always
    // sees, so it cannot be the unstyled path.
    assert.match(css, /\.nftmedia\.na\s*\{/);
    assert.match(css, /\.nftmedia \.nftmedia-ph\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// Layout rules that a rendering test cannot see.
//
// Both of these shipped and were caught only on a real phone, from screenshots:
// the drawer was see-through, and the header painted its breadcrumb over the
// network chip. Neither is visible to renderToStaticMarkup, which is why they
// are asserted against the stylesheet instead.
// ---------------------------------------------------------------------------

/** The body of every rule whose selector matches, media queries included. */
function rulesFor(pattern: RegExp): string[] {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    if (pattern.test(match[1] ?? '')) bodies.push(match[2] ?? '');
  }
  return bodies;
}

describe('the drawer is an opaque overlay', () => {
  test('--drawer-bg is defined and fully opaque in both themes', () => {
    const values = [...css.matchAll(/--drawer-bg:\s*([^;]+);/g)].map((match) => match[1]!.trim());
    assert.equal(values.length, 2, 'both themes must define a drawer surface');
    for (const value of values) {
      // An rgba() or a transparent keyword here is the exact defect: the rail's
      // own --rail-bg is rgba(255,255,255,.012), which is invisible as a grid
      // column background and see-through as an overlay.
      assert.match(value, /^#[0-9a-f]{6}$/i, `drawer background must be opaque, got ${value}`);
    }
  });

  test('every fixed drawer paints on that surface, not on the rail colour', () => {
    const fixed = rulesFor(/aside\.left/).filter((body) => /position:\s*fixed/.test(body));
    assert.ok(fixed.length >= 2, 'the app and mini shells both turn the rail into a drawer');
    for (const body of fixed) {
      assert.match(body, /background:\s*var\(--drawer-bg\)/, 'a fixed drawer must be opaque');
      assert.match(body, /z-index:\s*50/, 'the drawer must sit above the scrim');
    }
  });

  test('the scrim sits under the drawer and over the page', () => {
    const scrim = rulesFor(/\.scrim\s*$/).join(' ');
    assert.match(scrim, /position:\s*fixed/);
    assert.match(scrim, /z-index:\s*40/);
  });
});

describe('the phone header cannot overlap or overflow', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 900px)'));

  test('the breadcrumb is removed rather than left to wrap over the chips', () => {
    assert.match(phone, /\.crumb\s*\{\s*display:\s*none/);
  });

  test('the network chip is dropped by its own class, not by "not .mono"', () => {
    // `:not(.mono)` also matched the "not connected" chip — the one message
    // that has to survive on a phone.
    assert.match(phone, /\.netchip\s*\{\s*display:\s*none/);
    assert.ok(!/chip:not\(\.mono\)/.test(css), 'the not-connected chip must not be hidden by accident');
  });

  test('the remaining chip may ellipsize instead of pushing the toggle off-screen', () => {
    assert.match(phone, /header > \.chip\s*\{[^}]*min-width:\s*0/);
    assert.match(phone, /header > \.chip\s*\{[^}]*text-overflow:\s*ellipsis/);
    assert.match(phone, /\.themetog\s*\{\s*flex:\s*none/);
  });

  test('the status bar still scrolls rather than clipping', () => {
    // Confirmed working on device; asserted so a later header fix does not
    // "tidy" the overflow away.
    assert.match(rulesFor(/\.mio-console footer\s*$/).join(' '), /overflow-x:\s*auto/);
  });
});

// ---------------------------------------------------------------------------
// `.kv` is a ROW, not a list.
//
// console.css declares it `display: flex; justify-content: space-between` with
// `.k` and `.v` children. BudgetPaymentsPanel used it as a CONTAINER of rows —
// `<div class="kv"><div><span/><span/></div>…</div>` — so each inner div became
// an ordinary block whose two inline spans butted straight up against each
// other, and Settings shipped "Monthly limit0.1 USDC Spent0 USDC".
//
// The class name was right, which is why the existing vocabulary guard passed.
// This checks the level it is used AT.
// ---------------------------------------------------------------------------
describe('.kv is used as a row, not as a wrapper around rows', () => {
  const panels = readdirSync(new URL('../src/console/', import.meta.url))
    .filter((file) => file.endsWith('.tsx'));

  for (const file of panels) {
    const source = readFileSync(new URL(`../src/console/${file}`, import.meta.url), 'utf8');

    test(`${file} puts no block element directly inside a .kv`, () => {
      // A `.kv` opened and then followed by a `<div` before it closes means the
      // row is being used as a list. Deliberately crude: it reads the JSX as
      // text, which is enough to catch the shape and cheap enough to keep.
      const offenders: string[] = [];
      const pattern = /className="kv"[^>]*>([\s\S]{0,400}?)<\/div>/g;
      for (const match of source.matchAll(pattern)) {
        if (/<div\b/.test(match[1]!)) offenders.push(match[1]!.trim().split('\n')[0]!);
      }
      assert.deepEqual(offenders, [], `${file} nests a div inside a .kv row`);
    });

    test(`${file} labels every .kv child as .k or .v`, () => {
      // An unclassed span inside a row inherits neither the muted colour nor
      // the right alignment, which is the same defect wearing a different hat.
      const rows = source.matchAll(/className="kv"[^>]*>([\s\S]{0,400}?)<\/div>/g);
      for (const row of rows) {
        for (const span of row[1]!.matchAll(/<span([^>]*)>/g)) {
          // Static `className="v mono"` and conditional
          // `className={x ? 'v warn' : 'v'}` both count: what matters is that
          // every branch names the role, not how the string is built.
          const attribute = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(span[1]!);
          const labelled = attribute !== null && /(^|[\s'"`])[kv]([\s'"`]|$)/.test(attribute[1] ?? attribute[2] ?? '');
          assert.ok(labelled, `${file} has an unclassed span in a .kv row: <span${span[1]}>`);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A hash is 66 characters with no break opportunity, and a batch id can be
// several hundred. Observed in production: the Proof screen's execution
// timeline held an unbroken 450-character batch id, which widened its grid
// column, pushed the "Plan vs actual" panel off the right edge and gave the
// whole page a horizontal scrollbar.
//
// Two independent causes, so two assertions. Wrapping alone is not enough —
// a grid track's automatic minimum is its content's min-content width, so an
// unbreakable string expands the track no matter what the text does.
// ---------------------------------------------------------------------------
describe('a long hash cannot widen the page', () => {
  test('every value line that can hold a hash is allowed to wrap', () => {
    // The classes a hash, an address or a token symbol actually lands in.
    for (const selector of ['.tl .ts', '.call .cs', '.kv .v', '.cardrow .cr-v']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = new RegExp(`${escaped}[^{]*\\{[^}]*overflow-wrap:\\s*anywhere`);
      const grouped = new RegExp(`${escaped},[\\s\\S]{0,300}?overflow-wrap:\\s*anywhere`);
      assert.ok(rule.test(css) || grouped.test(css), `${selector} has no overflow-wrap rule`);
    }
  });

  test('no grid track is a bare 1fr — every one can shrink below its content', () => {
    const offenders: string[] = [];
    for (const match of css.matchAll(/grid-template-columns:([^;]+);/g)) {
      const value = match[1]!;
      // `minmax(0,1fr)` is the shrinkable form. A bare `1fr` is not, and that
      // is what let one string decide the width of the page.
      const withoutMinmax = value.replace(/minmax\([^)]*\)/g, '');
      if (/\b[\d.]*fr\b/.test(withoutMinmax)) offenders.push(value.trim());
    }
    assert.deepEqual(offenders, [], 'a bare fr track lets unbreakable content set the page width');
  });
});

describe('dense Route KPIs stay inside their cards', () => {
  test('a KPI track can shrink and both value lines wrap long financial text', () => {
    assert.match(rulesFor(/\.mio-console \.kpi\s*$/).join(' '), /min-width:\s*0/);
    assert.match(rulesFor(/\.mio-console \.kpi \.v\s*$/).join(' '), /overflow-wrap:\s*anywhere/);
    assert.match(rulesFor(/\.mio-console \.kpi \.d\s*$/).join(' '), /overflow-wrap:\s*anywhere/);
  });
});

// ---------------------------------------------------------------------------
// The shared `Button` is dressed in Tailwind utilities. The interface build
// does not generate them for `lib/ui` sources — the compiled stylesheet holds
// no `from-accent`, no `to-accent-2`, no `.bg-gradient-to-r` — so a `Button`
// dropped onto a console screen renders as plain text.
//
// Observed: "Confirm in Base Account", the one control that opens the wallet,
// sat as unstyled words beside a properly drawn "Back to routes". The obvious
// button was the one that did nothing.
// ---------------------------------------------------------------------------
describe('a console control is styled by the console', () => {
  const consoleScreens = readFileSync(
    new URL('../../../artifacts/interface/src/features/console/RouteIntelligenceConsole.tsx', import.meta.url),
    'utf8',
  );

  test('every wallet-actions button on the console carries a console class', () => {
    const uses = [...consoleScreens.matchAll(/<BlueprintSubmitButton([\s\S]{0,1500}?)\/>/g)];
    assert.ok(uses.length > 0, 'the console should still submit blueprints');
    for (const use of uses) {
      assert.match(
        use[1]!,
        /className="btn/,
        'a BlueprintSubmitButton without a console class renders as plain text',
      );
    }
  });
});
