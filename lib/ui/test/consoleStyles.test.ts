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

/**
 * Components styled by console.css but living OUTSIDE src/console — paths
 * relative to `lib/ui`, so another package's file can be named too.
 *
 * The guard scanned one directory, and `PublicMetricsDashboard.tsx` — a public
 * page, styled entirely by this stylesheet — sits a level above it. Three of
 * its classes had no rule and the guard could not see them.
 *
 * The Earn surface was the same hole one package wider. `EarnRouteCard.tsx`
 * and `wallet-actions/EarnDepositFlow.tsx` render on the web console and in
 * Base App, and both were written entirely in Tailwind — which NO build
 * generates for `lib/*` sources. The compiled interface stylesheet contains no
 * `.rounded-2xl` and no `.grid-cols-2` at all, so every `<dl>` in the Earn
 * Route Card collapsed into run-together words and "Review deposit" rendered
 * as plain text. Anything styled by this stylesheet belongs in the sweep,
 * wherever it lives.
 */
const EXTERNAL_CONSUMERS_V1 = [
  'src/PublicMetricsDashboard.tsx',
  'src/EarnRouteCard.tsx',
  '../wallet-actions/src/EarnDepositFlow.tsx',
];

function consoleSources(): { file: string; source: string }[] {
  const inConsole = readdirSync(consoleDir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => ({ file: name, source: readFileSync(path.join(consoleDir, name), 'utf8') }));
  const outside = EXTERNAL_CONSUMERS_V1.map((name) => ({
    file: name,
    source: readFileSync(path.join(here, '..', name), 'utf8'),
  }));
  return [...inConsole, ...outside];
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

/**
 * `pm-node-${tone}` leaves the prefix `pm-node-` once the interpolation is
 * blanked. That is not a class, so it can never match a rule by name — but
 * exempting it outright would leave every variant unchecked. A prefix is
 * satisfied when the stylesheet defines at least one class that starts with it,
 * which is exactly the claim the component is making.
 */
function prefixIsStyledV1(token: string): boolean {
  if (!token.endsWith('-')) return false;
  for (const name of defined) {
    if (name.length > token.length && name.startsWith(token)) return true;
  }
  return false;
}

describe('every console class has a stylesheet rule', () => {
  test('no panel invents a class vocabulary nobody styled', () => {
    const orphans: string[] = [];
    for (const { file, source } of consoleSources()) {
      for (const token of new Set(classTokens(source))) {
        if (defined.has(token) || EXTERNAL_V1.has(token) || prefixIsStyledV1(token)) continue;
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

describe('the B20 copilot reads as evidence, not a floating chat widget', () => {
  test('the answer is stamped to an observation and shrinks on Base App', () => {
    assert.match(css, /\.b20-copilot\s*\{[^}]*inset 3px 0 0 var\(--accent-line\)/);
    assert.match(css, /\.observation-stamp\s*\{/);
    assert.match(css, /\.mio-console\.mini \.b20-answer-facts\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  });

  test('long evidence values wrap instead of widening Discover cards', () => {
    const facts = rulesFor(/\.b20-answer-facts dd/).join(' ');
    assert.match(facts, /overflow-wrap:\s*anywhere/);
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

describe('a KPI stacks whatever element it is given', () => {
  // Shipped bug, seen on a phone and on a desktop alike: Discover's corpus
  // counters rendered as "Official issuance13Currently listed by a reviewed
  // Coinbase source". `.kpi` styled its children but never declared how they
  // stack, so the one screen that used spans instead of divs ran the label,
  // the number and the note together into a single sentence.
  test('an identity keeps its two labels apart in any card', () => {
    // `symbol` and `name` render as adjacent inline spans, so the separator is
    // pure CSS. Scoped to `.cardrow` it produced "CoinbaseB20 asset" on every
    // card that was not a `.cardrow` — the two strings ran together with no
    // space, on a component whose entire job is to keep an identity legible.
    assert.match(css, /\.mio-console \.cr-name \.sub\s*\{[^}]*margin-left/);
    assert.ok(
      !/\.mio-console \.cardrow \.cr-name \.sub\s*\{/.test(css),
      'the identity separator must not be scoped to one card class',
    );
  });

  test('the multi-issuer chip cannot be squeezed out of its own card', () => {
    // Shipped bug, seen on the Stocks chooser: three issuers on one row pushed
    // the badge past the card edge and it rendered as "MULTI-". The chip
    // carries the page's whole point, and a clipped word reads as a broken
    // product. The issuer list is the part allowed to shorten.
    assert.match(css, /\.mio-console \.mr-choice-issuers\s*\{[^}]*min-width:\s*0/);
    assert.match(css, /\.mio-console \.mr-choice-issuers\s*\{[^}]*text-overflow:\s*ellipsis/);
    assert.match(css, /\.mio-console \.mr-choice-tag\s*\{[^}]*flex:\s*none/);
  });

  test('.kpi declares its own stacking rather than inheriting it from divs', () => {
    const bodies = rulesFor(/\.mio-console \.kpi\s*$/);
    assert.ok(bodies.length > 0, '.mio-console .kpi must have a rule of its own');
    assert.ok(
      bodies.some((body) => /display:\s*(grid|flex)/.test(body)),
      'the stack must come from the rule, not from the element the caller picked',
    );
  });
});

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

  test('only the HEADER breadcrumb is removed, not every .crumb on the page', () => {
    // The unscoped rule also matched Discover's filter row, which is a `.crumb`
    // too — so every filter on the one screen built for choosing between
    // measured launches was invisible below 900px, which is every phone and all
    // of Base App. Nothing rendered wrong; the controls were simply not there.
    for (const rule of phone.matchAll(/([^{}]*\.crumb[^{}]*)\{([^{}]*)\}/g)) {
      if (!/display:\s*none/.test(rule[2] ?? '')) continue;
      assert.match(
        rule[1] ?? '',
        /header/,
        `a hide rule for .crumb must be scoped to the header, got: ${(rule[1] ?? '').trim()}`,
      );
    }
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
  for (const { file, source } of consoleSources()) {
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

describe('the inline B20 answer stays inside a Base App viewport', () => {
  test('the strip and answer can shrink, while every free-text line wraps', () => {
    assert.match(rulesFor(/\.mio-console \.ask-inline\s*$/).join(' '), /min-width:\s*0/);
    assert.match(rulesFor(/\.mio-console \.ask-inline\s*$/).join(' '), /max-width:\s*100%/);
    assert.match(rulesFor(/\.mio-console \.b20-answer\s*$/).join(' '), /min-width:\s*0/);
    assert.match(rulesFor(/\.mio-console \.b20-answer > p\s*$/).join(' '), /overflow-wrap:\s*anywhere/);
    assert.match(rulesFor(/\.mio-console \.b20-prompt-chips button\s*$/).join(' '), /overflow-wrap:\s*anywhere/);
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

  test('the shared Earn flow submits through a styled button too', () => {
    // The console screen passed `className="btn"` at its own call sites, but
    // Earn submits from inside the shared flow — so the one control that opens
    // the wallet for a deposit was reached by a path this guard never saw.
    const flow = readFileSync(
      new URL('../../wallet-actions/src/EarnDepositFlow.tsx', import.meta.url),
      'utf8',
    );
    const uses = [...flow.matchAll(/<BlueprintSubmitButton([\s\S]{0,1500}?)\/>/g)];
    assert.ok(uses.length > 0, 'the earn flow should still submit a blueprint');
    for (const use of uses) {
      assert.match(use[1]!, /className="btn/, 'the Earn deposit button renders as plain text');
    }
  });
});

// ---------------------------------------------------------------------------
// A phone layout a wider breakpoint outranks.
//
// `@media (max-width: 1400px)` sets `.mio-console.app.no-right` — specificity
// (0,3,0) — and the 900px block set only `.mio-console.app` — (0,2,0).
// Specificity beats source order ACROSS media queries, so on a 393px phone the
// grid stayed two columns: `main` measured 220px of 393 with a 173px empty
// track beside it. Every page without a right rail — Stocks, and therefore all
// of Base App's Stocks surface — rendered in 56% of the screen.
//
// Measured in Chromium at 393px before and after; this test is the cheap
// static guard so the pair cannot come apart again.
// ---------------------------------------------------------------------------

test('every app grid breakpoint covers the no-right variant too', () => {
  const blocks = [...css.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)];
  assert.ok(blocks.length >= 3, 'the media blocks are still findable');
  const checked: string[] = [];
  const offenders: string[] = [];
  for (const match of blocks) {
    const width = match[1]!;
    // Comments stripped FIRST: the fix's own comment names
    // `.mio-console.app.no-right` in prose, so a check that reads the raw block
    // passes on a file where the selector has been deleted — which is exactly
    // what this test caught itself doing.
    const body = match[2]!.replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/\.mio-console\.app[^{]*\{[^}]*grid-template-columns/.test(body)) continue;
    checked.push(`${width}px`);
    if (!body.includes('.mio-console.app.no-right')) offenders.push(`${width}px`);
  }
  // Without this the assertion below can pass because nothing was examined.
  assert.deepEqual(checked, ['1400px', '1180px', '900px'], 'the app grid breakpoints moved');
  assert.deepEqual(
    offenders,
    [],
    `these breakpoints set the app grid without the .no-right variant: ${offenders.join(', ')}`,
  );
});
