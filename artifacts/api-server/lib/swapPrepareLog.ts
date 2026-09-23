import type { TransactionPreparationResultV1 } from '@mioagent/transaction-composer';

// ---------------------------------------------------------------------------
// What a swap prepare that produced no calls leaves in the log.
//
// 2026-09-23: the operator pressed Approve and nothing happened. The Safety
// Kernel had refused the batch, and the reason travelled to the browser only —
// the server had nothing to read back. This line is that reason, in closed
// codes: the outcome, the refusal enum, the kernel's check ids, and our own
// error codes pulled from the details. Never a detail string itself, which can
// carry a provider's words or an address.
// ---------------------------------------------------------------------------

const OUR_CODE_V1 = /^[a-z][a-z0-9_]{2,80}$/;

/** The leading `code:` of a kernel check detail, when it is one of ours. */
function leadingCodeV1(detail: string | null): string | null {
  const head = detail?.split(':', 1)[0]?.trim() ?? '';
  return OUR_CODE_V1.test(head) ? head : null;
}

/** The trailing `(code)` a build failure puts in its refresh detail. */
function trailingCodeV1(detail: string): string | null {
  const code = /\(([a-z][a-z0-9_]{2,80})\)$/.exec(detail.trim())?.[1] ?? null;
  return code;
}

export function swapPrepareOutcomeMetaV1(
  result: Exclude<TransactionPreparationResultV1, { outcome: 'prepared' }>,
): Record<string, unknown> {
  switch (result.outcome) {
    case 'blocked':
      return {
        outcome: 'blocked',
        routeRunId: result.routeRunId,
        failedChecks: result.safety.checks
          .filter((check) => check.status === 'failed')
          .map((check) => ({ id: check.id, code: leadingCodeV1(check.detail) })),
        simulation: result.simulation?.status ?? null,
      };
    case 'refresh_required':
      return {
        outcome: 'refresh_required',
        routeRunId: result.routeRunId,
        reason: result.reason,
        errorCode: trailingCodeV1(result.detail),
      };
    case 'unsupported':
      return { outcome: 'unsupported', reason: result.reason };
  }
}
