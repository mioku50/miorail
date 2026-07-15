import { AddressV1Schema, stableHashV1 } from '@mioagent/route-domain';
import type { RouteRunRecord, RouteStorageRepository } from '@mioagent/route-storage';
import type { IntentResolutionV2 } from './types.js';

export interface IntentStorageBindingV2 {
  tenantId: string;
  walletAddress: string;
}

export type IntentPersistenceResultV2 =
  | { status: 'disabled'; record: null }
  | { status: 'not_ready'; record: null }
  | { status: 'persisted'; record: RouteRunRecord };

export function routeIntentV2IdempotencyKey(intent: {
  id: string;
  tenantId: string;
  walletAddress: string;
  intentHash: string;
}): string {
  return `intent-engine-v2:${stableHashV1('intent-engine-storage/v2', {
    id: intent.id,
    tenantId: intent.tenantId,
    walletAddress: intent.walletAddress,
    intentHash: intent.intentHash,
  })}`;
}

export function routeIntentStorageEnabledV2(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.MIORAIL_ROUTE_INTELLIGENCE_V1 === 'true';
}

export async function persistReadyRouteIntentV2(input: {
  repository: RouteStorageRepository;
  resolution: IntentResolutionV2;
  binding: IntentStorageBindingV2;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<IntentPersistenceResultV2> {
  if (!routeIntentStorageEnabledV2(input.env)) return { status: 'disabled', record: null };
  if (input.resolution.outcome !== 'ready') return { status: 'not_ready', record: null };

  const walletAddress = AddressV1Schema.parse(input.binding.walletAddress);
  if (
    input.binding.tenantId !== input.resolution.routeIntent.tenantId ||
    walletAddress !== input.resolution.routeIntent.walletAddress
  ) {
    throw new Error('Intent storage binding differs from the authenticated tenant or wallet');
  }

  const record = await input.repository.createRouteRun(
    input.resolution.routeIntent,
    routeIntentV2IdempotencyKey(input.resolution.routeIntent),
  );
  return { status: 'persisted', record };
}
