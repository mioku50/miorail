import { logger } from '@mioagent/utils';

import { safeFailureMetaV1, safeZodIssuesV1 } from './safeZodIssues.js';

// ---------------------------------------------------------------------------
// A 500 says why (audit OPS-1, 2026-11-14).
//
// Recording a swap's or an earn deposit's submission, and reconciling a Route
// Proof, answered 500 from a catch that logged nothing: on 2026-11-12 one such
// 500 left a proof `pending` for good beside an attempt later marked abandoned,
// and four reconcile 500s in two days left nothing to read. The journal had no
// error line at all.
//
// Now each of those answers is one error line first: the error's name, its
// redacted message and one repo-relative frame (safeFailureMetaV1), the step it
// failed at, a code when the error carries one, and a schema's issues by path
// and kind, never their values. No address, hash or key is written.
// ---------------------------------------------------------------------------

export function logRouteFailureV1(title: string, cause: unknown, stage: string): void {
  const raw = cause !== null && typeof cause === 'object' && 'code' in cause ? (cause as { code?: unknown }).code : undefined;
  const code = (typeof raw === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw)) || (typeof raw === 'number' && Number.isFinite(raw)) ? String(raw) : null;
  const issues = safeZodIssuesV1(cause);
  logger.error(title, { ...safeFailureMetaV1(cause), stage, ...(code ? { code } : {}), ...(issues ? { issues } : {}) });
}
