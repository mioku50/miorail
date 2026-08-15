import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  B20ConsolePanel,
  B20_CONSOLE_SCOPES_V1,
  B20_CONSOLE_SCOPE_COPY_V1,
  type B20ConsoleAnswerViewV1,
  type B20ConsolePanelModelV1,
} from '../src/console/B20ConsolePanel';

// The JSX below compiles to React.createElement.
void React;

// ---------------------------------------------------------------------------
// Stage 07 — the global console on screen.
//
// The per-card copilot stamps the observation it answered from. This panel has
// no single observation to stamp, so the property that replaces it is that the
// answer always shows WHAT WAS READ. These tests pin that, and the two places
// a global answer can mislead: a scope label that does not match the answer,
// and a count whose denominator is missing.
// ---------------------------------------------------------------------------

const noop = () => {};

const answerV1 = (over: Partial<B20ConsoleAnswerViewV1> = {}): B20ConsoleAnswerViewV1 => ({
  schemaVersion: 'b20-console-answer/v1',
  scope: 'explore',
  intent: 'universe_counts',
  answerSource: 'deterministic_evidence',
  answer: 'Miorail has stored measurements for 881 B20 launches detected in the last 48 hours.',
  facts: [{ label: 'Launches read', value: '881 in the last 48 hours', tone: 'neutral' }],
  missingEvidence: ['An Exit-First measurement for 44 launches in this window.'],
  caveats: ['This is a read of stored measurements.'],
  reads: [{ tool: 'summary', detail: '881 launches, window 48 hours' }],
  serverTime: '2026-08-15T12:00:00.000Z',
  ...over,
});

const model = (over: Partial<B20ConsolePanelModelV1> = {}): B20ConsolePanelModelV1 => ({
  scope: 'explore',
  tokenAddresses: [],
  loading: false,
  answer: null,
  error: null,
  onScopeChange: noop,
  onTokensChange: noop,
  onAsk: noop,
  ...over,
});

const render = (over: Partial<B20ConsolePanelModelV1> = {}) =>
  renderToStaticMarkup(<B20ConsolePanel {...model(over)} />);

describe('the three scopes are three questions, not a filter', () => {
  test('every scope is offered, and the current one is pressed', () => {
    const html = render({ scope: 'changes' });
    for (const scope of B20_CONSOLE_SCOPES_V1) {
      assert.ok(html.includes(B20_CONSOLE_SCOPE_COPY_V1[scope].label), `${scope} missing`);
    }
    assert.match(html, /aria-pressed="true"[^>]*>Changes/);
  });

  test('each scope says what it reads before anything is asked', () => {
    for (const scope of B20_CONSOLE_SCOPES_V1) {
      assert.ok(render({ scope }).includes(B20_CONSOLE_SCOPE_COPY_V1[scope].blurb));
    }
  });

  test('Investigate with no token says what it needs instead of an empty box', () => {
    const html = render({ scope: 'investigate' });
    assert.match(html, /Paste a Base token address/);
  });

  test('a selected token is removable and shown as an address', () => {
    const html = render({ scope: 'investigate', tokenAddresses: ['0xb200000000000000000000195a5f43905160ee01'] });
    assert.match(html, /0xb200…ee01/);
    assert.match(html, /aria-label="Remove 0xb200000000000000000000195a5f43905160ee01"/);
  });
});

describe('an answer says what it was built from', () => {
  test('the reads are shown, because there is no observation to stamp', () => {
    const html = render({ answer: answerV1() });
    assert.match(html, /What was read/);
    assert.match(html, /881 launches, window 48 hours/);
  });

  test('a rephrased answer is labelled as one', () => {
    const html = render({ answer: answerV1({ answerSource: 'verified_narration' }) });
    assert.match(html, /Every figure in it was checked against that evidence/);
  });

  test('a deterministic answer says it came from the measurements', () => {
    assert.match(render({ answer: answerV1() }), /Built directly from the stored measurements/);
  });

  test('evidence gaps are counted and kept, never dropped', () => {
    const html = render({ answer: answerV1() });
    assert.match(html, /1 evidence gaps/);
    assert.match(html, /An Exit-First measurement for 44 launches/);
  });
});

describe('the label always matches the answer', () => {
  test('an answer from another scope says so', () => {
    // An address in the question moves the answer to that token. Drawing a
    // token answer under an "Explore" heading would mislabel it.
    const html = render({ scope: 'explore', answer: answerV1({ scope: 'investigate', intent: 'compare_tokens' }) });
    assert.match(html, /Answered in Investigate/);
  });

  test('an answer from the open scope adds no such line', () => {
    assert.doesNotMatch(render({ scope: 'explore', answer: answerV1() }), /Answered in/);
  });
});

describe('failure is not silence', () => {
  test('an error is shown as a warning rather than an empty answer', () => {
    const html = render({ error: 'The console could not be read.' });
    assert.match(html, /class="note warn"/);
    assert.match(html, /The console could not be read\./);
  });

  test('the ask button states that it is reading', () => {
    assert.match(render({ loading: true }), />Reading…</);
  });
});

describe('a component a test renders can actually render', () => {
  test('every console component imported by a render test references React', () => {
    // This panel was written without the import and threw `React is not
    // defined` the first time a test rendered it. The two toolchains disagree:
    // Vite and Next compile these files with the AUTOMATIC JSX runtime, which
    // needs no import, and the test runner compiles the same file with the
    // classic transform, which emits `React.createElement`. So a component can
    // typecheck, build and render in the app while being unrenderable by the
    // only suite that proves it renders at all.
    //
    // Scoped to what render tests import, because that is exactly the set
    // where the disagreement is observable — and losing the ability to
    // render-test a screen is what this guard is protecting.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const consoleDir = path.join(here, '..', 'src', 'console');
    const rendered = new Set<string>();
    for (const name of readdirSync(here).filter((file) => file.endsWith('.test.tsx'))) {
      const source = readFileSync(path.join(here, name), 'utf8');
      for (const match of source.matchAll(/from '\.\.\/src\/console\/([A-Za-z0-9]+)'/g)) {
        rendered.add(`${match[1]}.tsx`);
      }
    }
    assert.ok(rendered.size > 0, 'the sweep found no render tests, so it is checking nothing');

    const offenders = [...rendered]
      .filter((name) => existsSync(path.join(consoleDir, name)))
      .filter((name) => !/\bimport React\b/.test(readFileSync(path.join(consoleDir, name), 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
