export function baseMcpApprovalLabel(state: unknown): string | null {
  if (state === 'approval_required') return 'Pending Base Account confirmation';
  if (state === 'pending') return 'Pending';
  if (state === 'completed') return 'Completed';
  if (state === 'rejected') return 'Rejected';
  if (state === 'failed') return 'Failed';
  return null;
}

export function historicalMessageModeLabel(metadata: Record<string, unknown>, currentLabel: string): string {
  if (metadata.networkLabel) return String(metadata.networkLabel);
  if (metadata.chainMode === 'mainnet-readonly' || metadata.readOnly === true) return 'Base Mainnet · Read-only';
  if (metadata.chainMode === 'mainnet' && metadata.userConfirmed === true) return 'Mainnet · User-confirmed';
  return currentLabel;
}

export function shouldShowBaseMcpConfirmation(metadata: Record<string, unknown>): boolean {
  return metadata.approvalTerminal !== true
    && !['completed', 'rejected', 'failed'].includes(String(metadata.approvalState || ''));
}
