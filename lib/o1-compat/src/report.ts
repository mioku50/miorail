import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  O1CompatibilityReportV1Schema,
  type O1CompatibilityFindingV1,
  type O1CompatibilityReportV1,
  type O1CompatibilityVerdictV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67D §12 — the report.
//
// Deterministic by construction: findings are sorted by id, the hash covers the
// findings and the verdict but NOT `checkedAt`, so the same subject produces the
// same reportHash on Monday and on Friday. A timestamp inside the hash would
// make "did the answer change?" unanswerable.
// ---------------------------------------------------------------------------

function canonicalJsonV1(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonV1(entry)}`).join(',')}}`;
}

export function hashJsonV1(value: unknown): `0x${string}` {
  return `0x${bytesToHex(sha256(utf8ToBytes(canonicalJsonV1(value))))}`;
}

export function orderFindingsV1(
  findings: readonly O1CompatibilityFindingV1[],
): O1CompatibilityFindingV1[] {
  return [...findings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The verdict rule, stated once.
 *
 * A single blocker is decisive. Not "many blockers are worse" — one requirement
 * that no configuration satisfies is already the whole answer, and averaging it
 * against passing checks would let a long list of green rows outvote it.
 */
export function verdictFromFindingsV1(
  findings: readonly O1CompatibilityFindingV1[],
): O1CompatibilityVerdictV1 {
  if (findings.some((entry) => entry.severity === 'blocker' && entry.status === 'incompatible')) {
    return 'incompatible';
  }
  if (findings.some((entry) => entry.status === 'incompatible')) return 'incompatible';
  if (findings.some((entry) => entry.status === 'unknown')) return 'unknown';
  if (findings.some((entry) => entry.status === 'conditionally_compatible')) {
    return 'conditionally_compatible';
  }
  return 'compatible';
}

export function buildCompatibilityReportV1(input: {
  source: 'fixtures' | 'live';
  subjectHash: `0x${string}`;
  findings: readonly O1CompatibilityFindingV1[];
  checkedAt: Date;
}): O1CompatibilityReportV1 {
  const findings = orderFindingsV1(input.findings);
  const verdict = verdictFromFindingsV1(findings);
  const blockers = findings
    .filter((entry) => entry.severity === 'blocker' && entry.status === 'incompatible')
    .map((entry) => entry.id);

  const sealed = {
    schemaVersion: 'o1-compatibility-report/v1' as const,
    gateVersion: 'o1-compat/v1' as const,
    source: input.source,
    subjectHash: input.subjectHash,
    checkedAt: input.checkedAt.toISOString(),
    verdict,
    blockers,
    findings,
  };
  return O1CompatibilityReportV1Schema.parse({
    ...sealed,
    // `checkedAt` is excluded so the same subject hashes the same forever.
    reportHash: hashJsonV1({ ...sealed, checkedAt: undefined }),
  });
}

/** §12 — the summary table. One row per check name the spec names, in the order
 * the spec names them, so an operator can read it against the task. */
const TABLE_ROWS_V1: ReadonlyArray<{ label: string; ids: readonly string[] }> = [
  { label: 'Server-side API auth', ids: ['server_side_api_auth'] },
  { label: 'Base Account signing', ids: ['requires_raw_transaction_signing', 'eip1271_support_unstated'] },
  { label: 'Raw transaction signing', ids: ['requires_user_private_key', 'requires_raw_transaction_signing'] },
  { label: 'Permit2', ids: ['permit2_parameters_undocumented', 'eip1271_support_unstated'] },
  { label: 'Exact approval', ids: ['permit2_parameters_undocumented'] },
  { label: 'Atomic wallet_sendCalls', ids: ['atomicity_unspecified', 'requires_provider_broadcast'] },
  { label: 'Alchemy simulation', ids: ['cannot_simulate_final_bytes', 'calldata_mutated_after_quote'] },
  { label: 'Builder Code', ids: ['builder_code_cannot_survive'] },
  { label: 'B20 preflight', ids: ['b20_preflight_not_run', 'b20_not_applicable', 'b20_controls_clear', 'b20_transfer_blocked', 'b20_not_evaluated'] },
  { label: 'Route Candidate evidence', ids: ['quote_evidence_absent', 'quote_freshness_absent'] },
  { label: 'Route Proof', ids: ['cannot_reconcile_onchain_result'] },
  { label: 'Submission recovery', ids: ['submission_recovery_unavailable'] },
];

/** The worst status among the named findings; `unknown` when none is present,
 * because a row with no finding behind it has not been checked. */
function rowStatusV1(report: O1CompatibilityReportV1, ids: readonly string[]): string {
  const present = report.findings.filter((entry) => ids.includes(entry.id));
  if (present.length === 0) return 'not checked';
  if (present.some((entry) => entry.status === 'incompatible')) return 'incompatible';
  if (present.some((entry) => entry.status === 'unknown')) return 'unknown';
  if (present.some((entry) => entry.status === 'conditionally_compatible')) {
    return 'conditionally compatible';
  }
  return 'compatible';
}

export function renderCompatibilityTableV1(report: O1CompatibilityReportV1): string {
  const width = Math.max(...TABLE_ROWS_V1.map((row) => row.label.length), 'Check'.length);
  const lines = [
    `${'Check'.padEnd(width)}  Result`,
    `${'-'.repeat(width)}  ${'-'.repeat(24)}`,
    ...TABLE_ROWS_V1.map((row) => `${row.label.padEnd(width)}  ${rowStatusV1(report, row.ids)}`),
  ];
  return lines.join('\n');
}

export function renderCompatibilityReportV1(report: O1CompatibilityReportV1): string {
  const out: string[] = [
    `o1 Trading API compatibility — ${report.gateVersion}`,
    `   · source:      ${report.source}`,
    `   · subject:     ${report.subjectHash}`,
    `   · report hash: ${report.reportHash}`,
    '',
    renderCompatibilityTableV1(report),
    '',
    `VERDICT: ${report.verdict}`,
  ];
  if (report.blockers.length > 0) {
    out.push('', 'Hard blockers:');
    for (const id of report.blockers) {
      const entry = report.findings.find((candidate) => candidate.id === id)!;
      out.push(`   ✗ ${id}`);
      out.push(`     ${entry.reason}`);
    }
  }
  const unknowns = report.findings.filter((entry) => entry.status === 'unknown');
  if (unknowns.length > 0) {
    out.push('', 'Undetermined (not the same as safe):');
    for (const entry of unknowns) out.push(`   ? ${entry.id} — ${entry.evidence}`);
  }
  return out.join('\n');
}
