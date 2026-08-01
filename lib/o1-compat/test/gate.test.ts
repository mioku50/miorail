import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  runCompatibilityGateV1,
  verdictFromFindingsV1,
  renderCompatibilityReportV1,
  responseFindingsV1,
  O1CompatibilityReportV1Schema,
} from '../src/index.js';
import {
  baseOrderRequestFixtureV1,
  baseOrderResponseFixtureV1,
  chainMismatchResponseFixtureV1,
  doublePlaceholderResponseFixtureV1,
  opaqueCalldataResponseFixtureV1,
  unlimitedApprovalResponseFixtureV1,
} from './fixtures.js';

// T67D — the gate's job is to reach an honest verdict about a provider Miorail
// would like to support. Every test here is a way the answer could be made to
// look better than it is.

const AT = new Date('2026-08-01T00:00:00.000Z');

function report(input: Parameters<typeof runCompatibilityGateV1>[0]) {
  return O1CompatibilityReportV1Schema.parse(runCompatibilityGateV1(input));
}

describe('the verdict', () => {
  test('the specification alone is already incompatible', () => {
    // No live response needed. The blockers are properties of the protocol.
    const result = report({ b20: 'not_run', checkedAt: AT });
    assert.equal(result.verdict, 'incompatible');
    assert.equal(result.source, 'fixtures');
  });

  test('every hard blocker the task names is present and named', () => {
    const result = report({ b20: 'clear', checkedAt: AT });
    for (const id of [
      'requires_user_private_key',
      'requires_raw_transaction_signing',
      'requires_provider_broadcast',
      'calldata_mutated_after_quote',
      'cannot_simulate_final_bytes',
      'builder_code_cannot_survive',
      'cannot_reconcile_onchain_result',
      'submission_recovery_unavailable',
    ]) {
      assert.ok(result.blockers.includes(id), `${id} must be reported as a blocker`);
    }
  });

  test('a well-formed live response does not soften the verdict', () => {
    // This is the failure mode the gate exists to prevent: a clean-looking
    // batch reading as "it works", when what it demonstrates is only that the
    // provider can produce a batch.
    const clean = report({
      request: baseOrderRequestFixtureV1(),
      response: baseOrderResponseFixtureV1(),
      b20: 'clear',
      checkedAt: AT,
    });
    assert.equal(clean.verdict, 'incompatible');
    assert.equal(clean.source, 'live');
    assert.ok(clean.blockers.includes('requires_raw_transaction_signing'));
  });

  test('one blocker outweighs any number of passing checks', () => {
    const findings = [
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `ok_${index}`,
        category: 'authentication' as const,
        status: 'compatible' as const,
        severity: 'info' as const,
        evidence: 'e',
        reason: 'r',
        requiredChange: null,
      })),
      {
        id: 'one_blocker',
        category: 'custody' as const,
        status: 'incompatible' as const,
        severity: 'blocker' as const,
        evidence: 'e',
        reason: 'r',
        requiredChange: null,
      },
    ];
    assert.equal(verdictFromFindingsV1(findings), 'incompatible');
  });

  test('unknown never rounds up to compatible', () => {
    assert.equal(
      verdictFromFindingsV1([
        { id: 'a', category: 'permit2', status: 'compatible', severity: 'info', evidence: 'e', reason: 'r', requiredChange: null },
        { id: 'b', category: 'permit2', status: 'unknown', severity: 'major', evidence: 'e', reason: 'r', requiredChange: null },
      ]),
      'unknown',
    );
  });
});

describe('response decoding', () => {
  const request = baseOrderRequestFixtureV1();

  function ids(response: Parameters<typeof responseFindingsV1>[0]) {
    return responseFindingsV1(response, {
      networkId: request.networkId,
      signerAddress: request.signerAddress,
    }).map((entry) => entry.id);
  }

  test('a Base request answered with chainId 1 is refused', () => {
    // The documented example does exactly this, which is why it is checked at
    // runtime rather than assumed from the schema.
    assert.ok(ids(chainMismatchResponseFixtureV1()).includes('provider_chain_mismatch_0'));
  });

  test('a selector Miorail cannot decode is refused', () => {
    assert.ok(ids(opaqueCalldataResponseFixtureV1()).includes('opaque_provider_calldata_0'));
  });

  test('an effectively unlimited approval is refused', () => {
    assert.ok(ids(unlimitedApprovalResponseFixtureV1()).includes('unbounded_approval_0'));
  });

  test('an exact approval is not flagged as unbounded', () => {
    // The fixture approves 1_000_000. A check that flagged every approval would
    // be noise rather than a control.
    assert.equal(ids(baseOrderResponseFixtureV1()).includes('unbounded_approval_0'), false);
  });

  test('a single signature placeholder is a blocker, and two are a different one', () => {
    assert.ok(ids(baseOrderResponseFixtureV1()).includes('signature_placeholder_present_1'));
    assert.ok(ids(doublePlaceholderResponseFixtureV1()).includes('ambiguous_signature_placeholder_1'));
  });
});

describe('B20 preflight (§8)', () => {
  test('not_b20 is a normal pass, not a failure', () => {
    const result = report({ b20: 'not_b20', checkedAt: AT });
    const b20 = result.findings.find((entry) => entry.category === 'b20_controls')!;
    assert.equal(b20.status, 'compatible');
    assert.equal(result.blockers.includes(b20.id), false);
  });

  test('a blocked transfer policy is a blocker', () => {
    const result = report({ b20: 'blocked', checkedAt: AT });
    assert.ok(result.blockers.includes('b20_transfer_blocked'));
  });

  test('an unsupported variant is Not evaluated, which is not safe', () => {
    const result = report({ b20: 'unsupported_variant', checkedAt: AT });
    const b20 = result.findings.find((entry) => entry.category === 'b20_controls')!;
    assert.equal(b20.status, 'unknown');
    assert.match(b20.reason, /not safe/i);
  });
});

describe('quote evidence (§9)', () => {
  test('missing minimum output forbids scoring', () => {
    const result = report({ b20: 'clear', checkedAt: AT });
    const quote = result.findings.find((entry) => entry.id === 'quote_evidence_absent')!;
    assert.equal(quote.status, 'incompatible');
    assert.match(quote.reason, /minimum output/i);
  });

  test('the MEV claim stays Not scored', () => {
    const result = report({ b20: 'clear', checkedAt: AT });
    const mev = result.findings.find((entry) => entry.id === 'mev_protection_is_a_claim')!;
    assert.equal(mev.status, 'unknown');
    assert.match(mev.evidence, /REQUEST input/);
    assert.match(mev.reason, /not evidence/i);
  });
});

describe('the report is deterministic', () => {
  test('the same fixtures produce the same report hash', () => {
    const a = report({ b20: 'clear', checkedAt: AT });
    const b = report({ b20: 'clear', checkedAt: new Date('2027-01-01T00:00:00.000Z') });
    assert.equal(a.reportHash, b.reportHash, 'the clock must not change the hash');
    assert.notEqual(a.checkedAt, b.checkedAt);
  });

  test('a different subject produces a different hash', () => {
    const withoutResponse = report({ b20: 'clear', checkedAt: AT });
    const withResponse = report({
      request: baseOrderRequestFixtureV1(),
      response: baseOrderResponseFixtureV1(),
      b20: 'clear',
      checkedAt: AT,
    });
    assert.notEqual(withoutResponse.reportHash, withResponse.reportHash);
    assert.notEqual(withoutResponse.subjectHash, withResponse.subjectHash);
  });

  test('findings are ordered, so two runs cannot disagree on presentation', () => {
    const result = report({ b20: 'clear', checkedAt: AT });
    const ids = result.findings.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort());
  });
});

describe('the rendered table', () => {
  test('names every check the task lists and ends in a verdict', () => {
    const rendered = renderCompatibilityReportV1(report({ b20: 'clear', checkedAt: AT }));
    for (const label of [
      'Server-side API auth',
      'Base Account signing',
      'Raw transaction signing',
      'Permit2',
      'Exact approval',
      'Atomic wallet_sendCalls',
      'Alchemy simulation',
      'Builder Code',
      'B20 preflight',
      'Route Candidate evidence',
      'Route Proof',
      'Submission recovery',
    ]) {
      assert.ok(rendered.includes(label), `the table must include "${label}"`);
    }
    assert.match(rendered, /VERDICT: incompatible/);
  });

  test('an undetermined check is shown as undetermined, not omitted', () => {
    const rendered = renderCompatibilityReportV1(report({ b20: 'not_run', checkedAt: AT }));
    assert.match(rendered, /Undetermined \(not the same as safe\)/);
  });
});

describe('T67D §14 — what this package must never contain', () => {
  const here = resolve(process.cwd(), process.cwd().endsWith('o1-compat') ? 'src' : 'lib/o1-compat/src');
  const sources = readdirSync(here)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }));

  test('the package is not empty and every source was read', () => {
    assert.ok(sources.length >= 5, 'expected the gate sources to be present');
  });

  /** Strips comments and string literals. The gate's entire job is to QUOTE the
   * signing requirement — `evidence: 'await wallet.signTransaction(...)'` is the
   * finding, not a capability. What must not exist is executable code: a call, a
   * helper, an import, a field. This is that distinction, mechanised. */
  function executableCode(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  test('no signing, no private key, no completion endpoint in executable code', () => {
    for (const { name, text } of sources) {
      const code = executableCode(text);
      assert.equal(/\bsignTransaction\b/.test(code), false, `${name} must not call signTransaction`);
      assert.equal(/\bsignTypedData\b/.test(code), false, `${name} must not sign typed data`);
      assert.equal(/privateKey|PRIVATE_KEY/.test(code), false, `${name} must not handle a private key`);
      assert.equal(/order\/complete/.test(code), false, `${name} must not call /order/complete`);
      assert.equal(/\bsignedRawTransaction\b|\bsigned\s*:/.test(code), false, `${name} must not carry a signed transaction`);
    }
  });

  test('the requirement IS quoted, so the gate reports it rather than hiding it', () => {
    // The inverse assertion. A package that mentioned none of this would have
    // failed to document why the provider is incompatible.
    const checks = sources.find((entry) => entry.name === 'checks.ts')!.text;
    assert.match(checks, /wallet\.signTransaction/);
    assert.match(checks, /EXECUTE_TRADE_PRIVATE_KEY/);
    assert.match(checks, /order\/complete/);
  });

  test('the host and path are constants, not parameters', () => {
    const client = sources.find((entry) => entry.name === 'client.ts')!.text;
    assert.match(client, /https:\/\/\$\{O1_HOST_V1\}\$\{O1_ORDER_PATH_V1\}/);
    // No caller-supplied URL anywhere in the request path.
    assert.equal(/baseUrl|apiUrl|providerUrl/.test(client), false);
  });
});

describe('the research record exists and is pinned', () => {
  const root = (() => {
    let current = resolve(process.cwd());
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return process.cwd();
  })();

  test('the compatibility document records its sources and verdict', () => {
    const doc = readFileSync(
      resolve(root, 'docs/research/O1_TRADING_API_COMPATIBILITY.md'),
      'utf8',
    );
    // A verdict with no recorded source is an opinion.
    assert.match(doc, /09c575bea35e160408192e28f42626e29b480290/, 'the sample commit SHA must be pinned');
    assert.match(doc, /b67e3be2c8d32c98cd886a7de6d9fccdcfae4aa808a9f37498b8417451823eb3/, 'the sample file hash must be pinned');
    assert.match(doc, /incompatible_with_base_account_v1/);
    // The two products must stay separated.
    assert.match(doc, /DEX Aggregator API is a different product/i);
  });
});
