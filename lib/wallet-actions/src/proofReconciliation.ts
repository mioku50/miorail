import type { BlueprintSubmitStatus } from './useSubmitApprovedBlueprint';

/**
 * Whether a submission's proof may be read from Base now.
 *
 * After the wallet's own terminal answer, as before. And for a swap sent in
 * steps as soon as its last step is out: its transaction hashes are known
 * then, and the server reads their receipts from Base itself. Waiting for the
 * wallet's answer there was waiting for the wallet's own node, which is the one
 * that reads those receipts for the page: on 2026-11-12 a HIMSc purchase sent
 * in two steps landed, its page said "reconciling with the chain" until it was
 * left, no reconcile was ever asked for, and its proof stayed pending.
 *
 * A batch is not read before the wallet answers: until then it has an id and
 * no hash, and there is nothing on Base to read.
 */
export function submissionReconcilableV1(
  submission: { status: BlueprintSubmitStatus; proofId: string | null; txHashes: readonly string[] } | null | undefined,
  terminal: readonly BlueprintSubmitStatus[],
): boolean {
  if (!submission?.proofId) return false;
  if (terminal.includes(submission.status)) return true;
  return submission.status === 'submitted' && submission.txHashes.length > 0;
}
