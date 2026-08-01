import { b20FindingV1, responseFindingsV1, specFindingsV1 } from './checks.js';
import type { O1TradingOrderRequestV1, O1TradingOrderResponseV1 } from './contracts.js';
import { buildCompatibilityReportV1, hashJsonV1 } from './report.js';
import type { O1CompatibilityReportV1 } from './contracts.js';

// ---------------------------------------------------------------------------
// T67D — one entry point, so "what did the gate decide" has a single answer.
//
// The spec findings are always included. A live response can only ADD findings,
// never remove one: a well-formed order batch does not un-require a private
// key, and a gate that let a good response soften a protocol requirement would
// be measuring the wrong thing.
// ---------------------------------------------------------------------------

export type B20PreflightVerdictV1 =
  | 'not_b20'
  | 'clear'
  | 'blocked'
  | 'unsupported_variant'
  | 'not_run';

export interface RunCompatibilityGateInputV1 {
  /** Present only for a live run. */
  request?: O1TradingOrderRequestV1;
  response?: O1TradingOrderResponseV1;
  /** §8 — the B20 preflight outcome for the traded token. */
  b20: B20PreflightVerdictV1;
  checkedAt: Date;
}

export function runCompatibilityGateV1(
  input: RunCompatibilityGateInputV1,
): O1CompatibilityReportV1 {
  const live = Boolean(input.response && input.request);
  const findings = [
    ...specFindingsV1(),
    b20FindingV1(input.b20),
    ...(live
      ? responseFindingsV1(input.response!, {
          networkId: input.request!.networkId,
          signerAddress: input.request!.signerAddress,
        })
      : []),
  ];

  return buildCompatibilityReportV1({
    source: live ? 'live' : 'fixtures',
    // The subject is what was judged: the spec-and-sample baseline alone, or
    // that baseline plus the exact response. Two different subjects must not
    // share a report hash.
    subjectHash: hashJsonV1({
      gate: 'o1-compat/v1',
      b20: input.b20,
      request: input.request ?? null,
      response: input.response ?? null,
    }),
    findings,
    checkedAt: input.checkedAt,
  });
}
