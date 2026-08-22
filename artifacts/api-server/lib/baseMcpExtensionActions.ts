import type { Request } from 'express';
import type { ToolAggregator, ToolDef } from '@mioagent/tools';
import { canonicalUsdcForBaseChain } from '@mioagent/security/baseGuards';
import { screenAction } from '@mioagent/security';
import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import { createApiToolAggregatorForUser } from './baseMcpTools.js';
import { loadTokenSecurityContext } from './executionSecurity.js';
import {
  extractBaseMcpApprovalSnapshot,
  resolveBaseMcpApprovalLifecycle,
  type BaseMcpApprovalState,
  type BaseMcpDurableProof,
} from './baseMcpApprovalLifecycle.js';
import {
  BASE_MCP_WALLET_MISMATCH_ERROR_CODE,
  BASE_MCP_WALLET_MISMATCH_MESSAGE,
  BASE_MCP_WALLET_UNVERIFIED_ERROR_CODE,
  BASE_MCP_WALLET_UNVERIFIED_MESSAGE,
  verifyBaseMcpWalletMatch,
} from './baseMcpWalletReconciliation.js';
import { createViemBaseReceiptReader } from './baseReceiptReader.js';
import {
  PostgresBaseMcpActionReceiptRepositoryV1,
  baseMcpActionHashV1,
  publicBaseMcpActionReceiptV1,
  type BaseMcpActionReceiptRepositoryV1,
  type BaseMcpSendActionIntentV1,
  type BaseMcpX402ActionIntentV1,
  type BaseMcpVirtualsActionIntentV1,
  type StoredBaseMcpActionReceiptV1,
} from './baseMcpActionReceipts.js';
import { sanitizedToolErrorCode } from './streamReadRouting.js';
import {
  buildAvantisProviderHandoffV1,
  matchBaseMcpProviderIntentV1,
  type AvantisProviderHandoffV1,
} from './baseMcpProviderRouting.js';
import { reconcileBaseMcpVirtualsActionV1 } from './baseMcpVirtualsAction.js';
import { missingInputsReplyV1, missingProviderInputsV1 } from './baseMcpRequiredInputs.js';
import { baseMcpRuntimeSnapshotV1 } from './baseMcpRuntimeSnapshot.js';
import type { BaseMcpRuntimeSnapshotV1 } from '@mioagent/security';

const ADDRESS_V1 = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRANSFER_TOPIC_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type BaseMcpExtensionIntentV1 =
  | { kind: 'read'; providerId?: string; exampleId?: string | null; providerPrompt?: string }
  | { kind: 'handoff'; originalMessage: string; provider: string | null }
  | { kind: 'provider_handoff'; handoff: AvantisProviderHandoffV1 }
  | {
      kind: 'send_name';
      intent: Omit<BaseMcpSendActionIntentV1, 'recipient'> & { recipientName: string };
    }
  | { kind: 'send'; intent: BaseMcpSendActionIntentV1 }
  | { kind: 'x402'; intent: BaseMcpX402ActionIntentV1 }
  | { kind: 'virtuals_create'; intent: BaseMcpVirtualsActionIntentV1 }
  | { kind: 'needs_input'; errorCode: string; reply: string };

export interface BaseMcpExtensionActionResultV1 {
  kind: 'action' | 'failed';
  reply: string;
  errorCode: string | null;
  toolsAvailable: number;
  receipt: ReturnType<typeof publicBaseMcpActionReceiptV1> | null;
  approvalUrl: string | null;
  resultPreview?: string | null;
}

function canonicalUsdcAmount(value: string): { amount: string; amountAtomic: string } | null {
  const normalized = value.replace(',', '.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) return null;
  const [wholeRaw, fractionRaw = ''] = normalized.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionRaw.replace(/0+$/, '');
  const amount = fraction ? `${whole}.${fraction}` : whole;
  const amountAtomic = `${whole}${fractionRaw.padEnd(6, '0')}`.replace(/^0+(?=\d)/, '') || '0';
  if (BigInt(amountAtomic) <= 0n) return null;
  return { amount, amountAtomic };
}

/**
 * Deterministic intent boundary for the Extensions room.
 *
 * The model never chooses whether a wallet action is a route. Swap/yield are
 * detected before any tool inventory is created and handed to Routes AI.
 * Only a fully specified canonical-USDC transfer reaches the action runner.
 */
export function classifyBaseMcpExtensionIntentV1(
  message: string,
  runtime: BaseMcpRuntimeSnapshotV1 = baseMcpRuntimeSnapshotV1(),
): BaseMcpExtensionIntentV1 {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  const provider = matchBaseMcpProviderIntentV1(trimmed, runtime);
  if (provider?.disposition === 'handoff_to_routes') {
    return { kind: 'handoff', originalMessage: trimmed, provider: provider.pluginId };
  }
  // A Routes adapter exists and this runtime cannot finish the journey. The
  // user is told exactly that, HERE, rather than being walked into Routes AI
  // to meet a Safety Kernel refusal at the end of a five-step flow.
  if (provider?.disposition === 'route_unavailable_here') {
    return {
      kind: 'needs_input',
      errorCode: `base_mcp_${provider.pluginId.replace(/-/g, '_')}_route_unavailable`,
      reply: [
        `Miorail compares ${provider.pluginId} routes, and it cannot complete this one on this deployment, so it is not sending you to a Review screen that would refuse to sign.`,
        provider.routeCapability?.reason ?? 'The end-to-end path for this provider is not released here.',
        'Comparison against the other released providers still works — ask for the swap without naming a provider.',
      ].join(' '),
    };
  }
  if (provider?.disposition === 'handoff_to_provider_ui' && provider.pluginId === 'avantis') {
    const handoff = buildAvantisProviderHandoffV1(trimmed);
    if (!handoff) {
      return {
        kind: 'needs_input',
        errorCode: 'base_mcp_avantis_market_required',
        reply: 'Specify the Avantis market, for example BTC/USD or ETH/USD. Miorail did not select a default market and no position was opened.',
      };
    }
    return { kind: 'provider_handoff', handoff };
  }
  if (provider?.disposition === 'typed_x402_required') {
    // Name the fields, not the architecture. A user who is missing a logo URL
    // needs to hear "give me a logo URL", not a paragraph about x402 prepare
    // responses that reads as a refusal.
    const missing = missingProviderInputsV1(provider.pluginId, provider.exampleId, trimmed);
    if (missing && missing.missing.length > 0) {
      return {
        kind: 'needs_input',
        errorCode: `base_mcp_${provider.pluginId.replace(/-/g, '_')}_input_required`,
        reply: missingInputsReplyV1(missing),
      };
    }
    return {
      kind: 'needs_input',
      errorCode: `base_mcp_${provider.pluginId.replace(/-/g, '_')}_x402_adapter_required`,
      reply: `Every field ${provider.pluginId} needs for this operation is present. Miorail has no typed adapter for its x402 prepare response yet, so it will not substitute a generic URL for the payment terms the provider quotes. Nothing was sent or paid.`,
    };
  }
  if (provider?.disposition === 'action_in_extensions' && provider.pluginId === 'virtuals') {
    const match = trimmed.match(
      /\bcreate\s+(?:a\s+)?(?:virtuals\s+)?agent\s+(?:called|named)\s+(.+?)\s+(?:to|for)\s+(.+)$/iu,
    );
    if (!match) {
      return {
        kind: 'needs_input',
        errorCode: 'virtuals_agent_facts_required',
        reply: 'Give the Virtuals agent both an explicit name and purpose, for example: “Create a Virtuals agent called Mio Researcher to summarize Base research.” Email and payment-card setup are separate PII-sensitive actions.',
      };
    }
    return {
      kind: 'virtuals_create',
      intent: {
        operation: 'agent_create',
        agentName: match[1].trim(),
        agentDescription: match[2].trim(),
      },
    };
  }
  if (provider?.disposition === 'adapter_required') {
    return {
      kind: 'needs_input',
      errorCode: `base_mcp_${provider.pluginId.replace(/-/g, '_')}_action_adapter_required`,
      reply: `${provider.pluginId} is assigned to Base MCP Extensions and this action is recognized. Its current ${provider.lifecycleStage} stage has no typed action adapter yet, so no write tool was called.`,
    };
  }
  if (provider?.disposition === 'read_in_extensions') {
    return {
      kind: 'read',
      providerId: provider.pluginId,
      exampleId: provider.exampleId,
      providerPrompt: provider.providerPrompt,
    };
  }

  const x402Marker = /\bx402\b|paid\s+(?:api|endpoint|resource)|платн(?:ый|ого|ому)\s+(?:api|эндпоинт|ресурс)/iu;
  if (x402Marker.test(trimmed)) {
    const url = trimmed.match(/https:\/\/[^\s<>"']+/iu)?.[0]?.replace(/[),.;!?]+$/u, '');
    const cap = trimmed.match(/(?:max(?:imum)?(?:\s+payment)?|cap(?:\s+the\s+payment)?(?:\s+at)?|up\s+to|лимит|максимум|не\s+более|до)\s*[:=]?\s*(\d+(?:[.,]\d{1,6})?)\s*USDC/iu)?.[1];
    const money = cap ? canonicalUsdcAmount(cap) : null;
    if (!url || !money) {
      return {
        kind: 'needs_input',
        errorCode: 'base_mcp_x402_exact_input_required',
        reply: 'x402 V1 needs an exact HTTPS resource and a USDC cap, for example: “Pay x402 GET https://approved.example/resource, max 0.10 USDC”.',
      };
    }
    return {
      kind: 'x402',
      intent: {
        method: 'GET',
        url,
        maxPayment: money.amount,
        maxPaymentAtomic: money.amountAtomic,
        paymentAsset: {
          symbol: 'USDC',
          address: canonicalUsdcForBaseChain(8453).toLowerCase() as `0x${string}`,
          decimals: 6,
        },
      },
    };
  }

  const routable = /\b(?:swap|trade|exchange|best\s+(?:swap|rate|route)|yield|apy)\b|(?:обменяй|обменять|свап|лучший\s+курс|доходност)/iu;
  if (routable.test(lower)) return { kind: 'handoff', originalMessage: trimmed, provider: null };

  const sendMarker = /\b(?:send|transfer)\b|(?:отправь|отправить|переведи|перевести)/iu;
  if (sendMarker.test(trimmed)) {
    const match = trimmed.match(
      /(?:^|\s)(?:send|transfer|отправь|отправить|переведи|перевести)\s+(\d+(?:[.,]\d{1,6})?)\s+USDC\s+(?:to(?:\s+address)?|on(?:\s+address)?|на(?:\s+адрес)?|по\s+адресу|в)\s*(0x[a-fA-F0-9]{40}|[^\s,!?]{1,255}\.base\.eth)(?:\s|[.,!?]|$)/iu,
    );
    if (!match) {
      return {
        kind: 'needs_input',
        errorCode: 'base_mcp_send_exact_input_required',
        reply: 'Send V1 needs an exact USDC amount and either a Base address (0x…) or a Basename (*.base.eth). ETH and other ERC-20 assets are not released in this action vertical yet.',
      };
    }
    const money = canonicalUsdcAmount(match[1]);
    if (!money) {
      return {
        kind: 'needs_input',
        errorCode: 'base_mcp_send_amount_invalid',
        reply: 'Use a positive USDC amount with no more than 6 decimal places.',
      };
    }
    const recipientInput = match[2].toLowerCase();
    const asset = {
      symbol: 'USDC' as const,
      address: canonicalUsdcForBaseChain(8453).toLowerCase() as `0x${string}`,
      decimals: 6 as const,
    };
    if (!ADDRESS_V1.test(recipientInput)) {
      return {
        kind: 'send_name',
        intent: {
          asset,
          amount: money.amount,
          amountAtomic: money.amountAtomic,
          recipientName: recipientInput,
        },
      };
    }
    const recipient = recipientInput as `0x${string}`;
    return {
      kind: 'send',
      intent: {
        asset,
        amount: money.amount,
        amountAtomic: money.amountAtomic,
        recipient,
        recipientName: null,
      },
    };
  }

  if (/\b(?:sign|signature|eip-?712|launch|mint)\b|(?:подпиши|создай\s+токен)/iu.test(trimmed)) {
    return {
      kind: 'needs_input',
      errorCode: 'base_mcp_action_vertical_not_released',
      reply: 'Base MCP exposes that approval capability, but this exact action still needs a typed message or provider adapter before it can be released.',
    };
  }

  return { kind: 'read' };
}

function sendTool(inventory: Array<{ providerId: string; tools: ToolDef[] }>): ToolDef | undefined {
  return inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools)
    .find((tool) => /^(?:send|transfer|send_token|transfer_token)$/i.test(tool.name));
}

function exactTool(
  inventory: Array<{ providerId: string; tools: ToolDef[] }>,
  normalizedName: string,
): ToolDef | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return inventory
    .filter((entry) => entry.providerId.startsWith('base-mcp'))
    .flatMap((entry) => entry.tools)
    .find((tool) => normalize(tool.name) === normalizedName);
}

function safeX402UrlV1(value: string): { url: string | null; errorCode: string | null } {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      return { url: null, errorCode: 'base_mcp_x402_url_unsafe' };
    }
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    for (const key of url.searchParams.keys()) {
      if (/(?:api[-_]?key|access[-_]?token|auth|authorization|bearer|secret|signature|password)/iu.test(key)) {
        return { url: null, errorCode: 'base_mcp_x402_url_contains_secret' };
      }
    }
    if (
      host === 'localhost'
      || host.endsWith('.localhost')
      || host.endsWith('.local')
      || host === '0.0.0.0'
      || host === '::1'
      || /^127\./u.test(host)
      || /^10\./u.test(host)
      || /^192\.168\./u.test(host)
      || /^169\.254\./u.test(host)
      || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
      || /^\[(?:fc|fd|fe80):/iu.test(url.host)
    ) {
      return { url: null, errorCode: 'base_mcp_x402_private_host_blocked' };
    }
    url.hash = '';
    return { url: url.toString(), errorCode: null };
  } catch {
    return { url: null, errorCode: 'base_mcp_x402_url_invalid' };
  }
}

function maximumX402AtomicV1(): bigint {
  const configured = (process.env.BASE_MCP_ACTION_X402_MAX_USDC || '1').trim();
  const parsed = canonicalUsdcAmount(configured);
  return parsed ? BigInt(parsed.amountAtomic) : 1_000_000n;
}

const DEFAULT_BASE_MCP_X402_RECEIPT_TTL_MS = 24 * 60 * 60_000;

function baseMcpX402ReceiptTtlMsV1(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.BASE_MCP_ACTION_X402_TTL_SECONDS || '86400');
  return Number.isFinite(seconds) && seconds >= 60 && seconds <= 7 * 24 * 60 * 60
    ? Math.trunc(seconds * 1000)
    : DEFAULT_BASE_MCP_X402_RECEIPT_TTL_MS;
}

export function baseMcpX402ReceiptExpiredV1(
  receipt: StoredBaseMcpActionReceiptV1,
  now: string,
  ttlMs = baseMcpX402ReceiptTtlMsV1(),
): boolean {
  if (receipt.actionType !== 'x402' || ['completed', 'rejected', 'failed'].includes(receipt.status)) return false;
  const createdAt = Date.parse(receipt.createdAt);
  const checkedAt = Date.parse(now);
  return Number.isFinite(createdAt) && Number.isFinite(checkedAt) && checkedAt - createdAt >= ttlMs;
}

function approvedX402HostV1(value: string): boolean {
  const defaults = ['api.venice.ai', 'mcp.brickken.com'];
  const configured = (process.env.BASE_MCP_ACTION_X402_ALLOWED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const approved = new Set([...defaults, ...configured]);
  try {
    return approved.has(new URL(value).hostname.toLowerCase().replace(/\.$/u, ''));
  } catch {
    return false;
  }
}

function x402Args(tool: ToolDef, intent: BaseMcpX402ActionIntentV1): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties || {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const put = (aliases: string[], value: unknown) => {
    const key = aliases.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
    if (key) args[key] = value;
  };
  put(['url', 'resourceUrl', 'endpoint'], intent.url);
  put(['method', 'httpMethod'], intent.method);
  put(['maxPayment', 'maxPaymentUsdc', 'paymentCap'], intent.maxPayment);
  return Object.keys(args).length > 0
    ? args
    : { url: intent.url, method: intent.method, maxPayment: intent.maxPayment };
}

function completeX402Args(tool: ToolDef, requestId: string): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties || {}) as Record<string, unknown>;
  const key = ['requestId', 'request_id', 'id'].find((candidate) =>
    Object.prototype.hasOwnProperty.call(properties, candidate),
  );
  return { [key || 'requestId']: requestId };
}

function boundedX402PreviewV1(raw: string): string {
  const withoutControlCharacters = [...raw]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('');
  const text = withoutControlCharacters
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, 'Bearer [redacted]')
    .replace(/"(authorization|cookie|set-cookie|signature|payment-signature|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password)"\s*:\s*"[^"]*"/giu, '"$1":"[redacted]"')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.slice(0, 2000);
}

function sendArgs(tool: ToolDef, intent: BaseMcpSendActionIntentV1, walletAddress: string): Record<string, unknown> {
  const properties = (tool.inputSchema?.properties || {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const put = (aliases: string[], value: unknown) => {
    const key = aliases.find((candidate) => Object.prototype.hasOwnProperty.call(properties, candidate));
    if (key) args[key] = value;
  };
  put(['amount', 'value', 'tokenAmount'], intent.amount);
  put(['token', 'asset', 'tokenSymbol', 'currency'], 'USDC');
  put(['recipient', 'to', 'destination', 'toAddress'], intent.recipient);
  put(['walletAddress', 'from', 'fromAddress', 'sender'], walletAddress);
  put(['chainId'], 8453);
  put(['chain', 'network'], 'base');
  return Object.keys(args).length > 0
    ? args
    : {
        amount: intent.amount,
        token: 'USDC',
        recipient: intent.recipient,
        walletAddress,
        chainId: 8453,
      };
}

function terminal(state: BaseMcpApprovalState): boolean {
  return ['completed', 'rejected', 'failed'].includes(state);
}

function maximumSendAtomicV1(): bigint {
  const configured = (process.env.BASE_MCP_ACTION_SEND_MAX_USDC || '1000').trim();
  const parsed = canonicalUsdcAmount(configured);
  return parsed ? BigInt(parsed.amountAtomic) : 1_000_000_000n;
}

function durableProofRecord(proof?: BaseMcpDurableProof): Record<string, unknown> | null {
  return proof && Object.keys(proof).length > 0 ? { ...proof } : null;
}

function publicResult(
  receipt: StoredBaseMcpActionReceiptV1,
  approvalUrl: string | null,
  reply: string,
  errorCode: string | null = null,
  toolsAvailable = 0,
  resultPreview: string | null = null,
): BaseMcpExtensionActionResultV1 {
  return {
    kind: errorCode && receipt.status === 'failed' ? 'failed' : 'action',
    reply,
    errorCode,
    toolsAvailable,
    receipt: publicBaseMcpActionReceiptV1(receipt),
    approvalUrl,
    resultPreview,
  };
}

function failedWithoutReceipt(reply: string, errorCode: string): BaseMcpExtensionActionResultV1 {
  return { kind: 'failed', reply, errorCode, toolsAvailable: 0, receipt: null, approvalUrl: null, resultPreview: null };
}

function idempotencyConflictResult(
  receipt: StoredBaseMcpActionReceiptV1,
): BaseMcpExtensionActionResultV1 {
  return {
    kind: 'failed',
    reply: 'That request ID is already bound to different action facts. Use a new request ID; no second Base MCP action was prepared.',
    errorCode: 'base_mcp_action_idempotency_conflict',
    toolsAvailable: 0,
    receipt: publicBaseMcpActionReceiptV1(receipt),
    approvalUrl: null,
    resultPreview: null,
  };
}

type ReceiptReaderV1 = ReturnType<typeof createViemBaseReceiptReader>;

export const baseMcpExtensionActionRuntime = {
  repository: new PostgresBaseMcpActionReceiptRepositoryV1() as BaseMcpActionReceiptRepositoryV1,
  createTools: createApiToolAggregatorForUser,
  verifyWallet: verifyBaseMcpWalletMatch,
  loadTokenSecurityContext,
  screenAction,
  createReceiptReader: createViemBaseReceiptReader as () => ReceiptReaderV1,
  now: () => new Date().toISOString(),
};

async function expireStaleBaseMcpX402ReceiptV1(
  receipt: StoredBaseMcpActionReceiptV1,
  now: string,
): Promise<StoredBaseMcpActionReceiptV1> {
  if (!baseMcpX402ReceiptExpiredV1(receipt, now)) return receipt;
  return (await baseMcpExtensionActionRuntime.repository.update({
    id: receipt.id,
    tenantId: receipt.tenantId,
    status: 'failed',
    reconciliationState: 'unavailable',
    errorCode: 'base_mcp_x402_expired',
    finalizedAt: now,
    now,
  })) ?? receipt;
}

async function verifyUsdcTransferOnchain(input: {
  transactionHash: HashV1;
  walletAddress: `0x${string}`;
  intent: BaseMcpSendActionIntentV1;
  reader: ReceiptReaderV1;
}): Promise<{
  state: 'matched' | 'mismatched' | 'unavailable';
  blockNumber: string | null;
  errorCode: string | null;
}> {
  const receipt = await input.reader.getTransactionReceipt(input.transactionHash);
  if (!receipt) return { state: 'unavailable', blockNumber: null, errorCode: 'base_mcp_receipt_unavailable' };
  const blockNumber = receipt.blockNumber.toString();
  if (receipt.status !== 'success') {
    return { state: 'mismatched', blockNumber, errorCode: 'base_mcp_transaction_reverted' };
  }

  const expectedFrom = input.walletAddress.toLowerCase();
  const expectedTo = input.intent.recipient.toLowerCase();
  const expectedToken = input.intent.asset.address.toLowerCase();
  const matched = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== expectedToken) return false;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC_V1 || log.topics.length < 3) return false;
    const from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    let amount: string;
    try {
      amount = BigInt(log.data || '0x0').toString();
    } catch {
      return false;
    }
    return from === expectedFrom && to === expectedTo && amount === input.intent.amountAtomic;
  });
  return matched
    ? { state: 'matched', blockNumber, errorCode: null }
    : { state: 'mismatched', blockNumber, errorCode: 'base_mcp_transfer_facts_mismatch' };
}

async function reconcileCompletedReceipt(input: {
  receipt: StoredBaseMcpActionReceiptV1;
  proof: BaseMcpDurableProof | undefined;
  now: string;
}): Promise<StoredBaseMcpActionReceiptV1> {
  if (input.receipt.actionType !== 'send') return input.receipt;
  const transactionHash = input.proof?.txHash?.toLowerCase() as HashV1 | undefined;
  if (!transactionHash) {
    return (await baseMcpExtensionActionRuntime.repository.update({
      id: input.receipt.id,
      tenantId: input.receipt.tenantId,
      status: 'reconciling',
      reconciliationState: 'pending',
      durableProof: durableProofRecord(input.proof),
      errorCode: 'base_mcp_transaction_hash_pending',
      now: input.now,
    }))!;
  }

  const verified = await verifyUsdcTransferOnchain({
    transactionHash,
    walletAddress: input.receipt.walletAddress,
    intent: input.receipt.intent as BaseMcpSendActionIntentV1,
    reader: baseMcpExtensionActionRuntime.createReceiptReader(),
  });
  if (verified.state === 'unavailable') {
    return (await baseMcpExtensionActionRuntime.repository.update({
      id: input.receipt.id,
      tenantId: input.receipt.tenantId,
      status: 'reconciling',
      reconciliationState: 'unavailable',
      durableProof: durableProofRecord(input.proof),
      transactionHash,
      errorCode: verified.errorCode,
      now: input.now,
    }))!;
  }

  const completed = verified.state === 'matched';
  return (await baseMcpExtensionActionRuntime.repository.update({
    id: input.receipt.id,
    tenantId: input.receipt.tenantId,
    status: completed ? 'completed' : 'failed',
    reconciliationState: verified.state,
    durableProof: durableProofRecord(input.proof),
    transactionHash,
    blockNumber: verified.blockNumber,
    errorCode: verified.errorCode,
    finalizedAt: input.now,
    now: input.now,
  }))!;
}

async function createExtensionTools(input: {
  req: Request;
  userId: string;
  sessionSecret: string;
  allowedActionTools?: readonly string[];
}): Promise<ToolAggregator> {
  return baseMcpExtensionActionRuntime.createTools(
    input.req,
    input.userId,
    input.sessionSecret,
    {
      baseMcpOnly: true,
      ...(input.allowedActionTools?.length ? { baseMcpAllowedActionTools: input.allowedActionTools } : {}),
    },
  );
}

export async function prepareBaseMcpSendActionV1(input: {
  req: Request;
  userId: string;
  walletAddress?: string;
  sessionSecret: string;
  idempotencyKey?: string;
  message: string;
  intent: BaseMcpSendActionIntentV1;
}): Promise<BaseMcpExtensionActionResultV1> {
  if (!input.idempotencyKey) {
    return failedWithoutReceipt('This action needs an idempotency request ID before Base MCP can be called.', 'base_mcp_action_request_id_required');
  }
  if (!input.walletAddress || !ADDRESS_V1.test(input.walletAddress)) {
    return failedWithoutReceipt('Connect Base Account before preparing a transfer.', 'base_mcp_action_wallet_required');
  }
  const walletAddress = input.walletAddress.toLowerCase() as `0x${string}`;
  if (input.intent.recipient === ZERO_ADDRESS || input.intent.recipient === walletAddress) {
    return failedWithoutReceipt('The recipient must be a different, non-zero Base address.', 'base_mcp_send_recipient_invalid');
  }
  if (BigInt(input.intent.amountAtomic) > maximumSendAtomicV1()) {
    return failedWithoutReceipt(
      `The transfer exceeds this server’s Base MCP action limit (${process.env.BASE_MCP_ACTION_SEND_MAX_USDC || '1000'} USDC).`,
      'base_mcp_send_capability_limit_exceeded',
    );
  }
  if (!(await baseMcpExtensionActionRuntime.repository.available())) {
    return failedWithoutReceipt('Action Receipt storage is unavailable, so no Base MCP action was prepared.', 'base_mcp_action_storage_unavailable');
  }

  const security = await baseMcpExtensionActionRuntime.loadTokenSecurityContext(8453, [input.intent.asset.address]);
  const tokenVerdict = security.tokenSecurity.find(
    (item) => item.address.toLowerCase() === input.intent.asset.address,
  );
  const screening = baseMcpExtensionActionRuntime.screenAction({
    instruction: input.message,
    providerContext: { ...security.providerContext, requiresTokenSecurity: true },
  });
  if (!screening.allowed || !tokenVerdict || tokenVerdict.provider !== 'goplus'
    || !['ok', 'warning'].includes(tokenVerdict.status)) {
    return failedWithoutReceipt('The transfer did not pass the live canonical-USDC safety check.', 'base_mcp_send_safety_check_failed');
  }

  const now = baseMcpExtensionActionRuntime.now();
  const created = await baseMcpExtensionActionRuntime.repository.create({
    tenantId: input.userId,
    walletAddress,
    idempotencyKey: input.idempotencyKey,
    actionType: 'send',
    intent: input.intent,
    now,
  });
  if (!created.created) {
    const expectedHash = baseMcpActionHashV1({
      tenantId: input.userId,
      walletAddress,
      idempotencyKey: input.idempotencyKey,
      actionType: 'send',
      intent: input.intent,
    });
    if (created.receipt.actionHash !== expectedHash) return idempotencyConflictResult(created.receipt);
    return publicResult(
      created.receipt,
      null,
      created.receipt.status === 'preparing'
        ? 'This idempotent action already started and its first response is uncertain. Miorail will not prepare a second transfer.'
        : 'This idempotent action already exists. Its Action Receipt was returned without preparing another transfer.',
      created.receipt.status === 'preparing' ? 'base_mcp_action_outcome_unknown' : created.receipt.errorCode,
    );
  }

  let tools: ToolAggregator;
  try {
    tools = await createExtensionTools({
      ...input,
      allowedActionTools: ['send', 'send_token', 'transfer', 'transfer_token'],
    });
  } catch {
    const failed = await baseMcpExtensionActionRuntime.repository.update({
      id: created.receipt.id,
      tenantId: input.userId,
      status: 'failed',
      reconciliationState: 'not_started',
      errorCode: 'base_mcp_connect_failed',
      finalizedAt: now,
      now,
    });
    return publicResult(failed!, null, 'Base MCP could not be reached. No approval request was returned.', 'base_mcp_connect_failed');
  }

  try {
    const inventory = await tools.listProviderTools();
    if (inventory.some((entry) => !entry.providerId.startsWith('base-mcp'))) {
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode: 'non_base_mcp_provider_registered',
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'The Extensions action boundary refused a non-Base-MCP provider.', 'non_base_mcp_provider_registered');
    }
    const toolsAvailable = inventory.reduce((total, entry) => total + entry.tools.length, 0);
    const tool = sendTool(inventory);
    if (!tool) {
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode: 'base_mcp_send_unavailable',
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'Base MCP did not expose its exact send tool.', 'base_mcp_send_unavailable', toolsAvailable);
    }

    const walletMatch = await baseMcpExtensionActionRuntime.verifyWallet(tools, walletAddress);
    if (!walletMatch.checked || !walletMatch.match) {
      const errorCode = walletMatch.checked
        ? BASE_MCP_WALLET_MISMATCH_ERROR_CODE
        : BASE_MCP_WALLET_UNVERIFIED_ERROR_CODE;
      const reply = walletMatch.checked ? BASE_MCP_WALLET_MISMATCH_MESSAGE : BASE_MCP_WALLET_UNVERIFIED_MESSAGE;
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode,
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, reply, errorCode, toolsAvailable);
    }

    const args = sendArgs(tool, input.intent, walletAddress);
    let called: { content: string; isError: boolean };
    try {
      called = await tools.callTool(tool.name, args);
    } catch {
      called = { content: JSON.stringify({ errorCode: 'base_mcp_send_failed' }), isError: true };
    }
    if (called.isError) {
      const errorCode = sanitizedToolErrorCode(called.content, 'base_mcp_send_failed');
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode,
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'Base MCP did not prepare the transfer.', errorCode, toolsAvailable);
    }

    const snapshot = extractBaseMcpApprovalSnapshot(called.content);
    if (!snapshot.requestId) {
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        durableProof: durableProofRecord(snapshot.proof),
        errorCode: 'base_mcp_request_id_missing',
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'Base MCP returned no durable request ID, so Miorail withheld the approval link.', 'base_mcp_request_id_missing', toolsAvailable);
    }

    const state: BaseMcpApprovalState = snapshot.state || (snapshot.approvalUrl ? 'approval_required' : 'pending');
    let receipt = await baseMcpExtensionActionRuntime.repository.update({
      id: created.receipt.id,
      tenantId: input.userId,
      status: state === 'completed' ? 'reconciling' : state,
      reconciliationState: state === 'completed' ? 'pending' : 'not_started',
      providerRequestId: snapshot.requestId,
      durableProof: durableProofRecord(snapshot.proof),
      errorCode: null,
      ...(terminal(state) && state !== 'completed' ? { finalizedAt: now } : {}),
      now,
    });
    if (!receipt) return failedWithoutReceipt('The Action Receipt could not be updated.', 'base_mcp_action_storage_failed');
    if (state === 'completed') receipt = await reconcileCompletedReceipt({ receipt, proof: snapshot.proof, now });

    const reply = state === 'completed'
      ? receipt.status === 'completed'
        ? 'The Base MCP transfer was matched to the expected USDC Transfer event on Base.'
        : 'Base MCP reports completion; Miorail is still reconciling the exact USDC Transfer event.'
      : state === 'rejected'
        ? 'The Base Account approval was rejected.'
        : state === 'failed'
          ? 'The Base MCP approval request failed.'
          : snapshot.approvalUrl
            ? `Base MCP prepared ${input.intent.amount} USDC. Review and approve the exact transfer in Base Account.`
            : 'The Base MCP approval request is pending. Check its Action Receipt before trying again.';
    return publicResult(receipt, snapshot.approvalUrl ?? null, reply, receipt.errorCode, toolsAvailable);
  } finally {
    await tools.close().catch(() => undefined);
  }
}

export async function prepareBaseMcpX402ActionV1(input: {
  req: Request;
  userId: string;
  walletAddress?: string;
  sessionSecret: string;
  idempotencyKey?: string;
  message: string;
  intent: BaseMcpX402ActionIntentV1;
}): Promise<BaseMcpExtensionActionResultV1> {
  if (!input.idempotencyKey) {
    return failedWithoutReceipt('This x402 request needs an idempotency request ID before Base MCP can be called.', 'base_mcp_action_request_id_required');
  }
  if (!input.walletAddress || !ADDRESS_V1.test(input.walletAddress)) {
    return failedWithoutReceipt('Connect Base Account before preparing an x402 payment.', 'base_mcp_action_wallet_required');
  }
  const checkedUrl = safeX402UrlV1(input.intent.url);
  if (!checkedUrl.url) {
    return failedWithoutReceipt('The x402 resource must be a public HTTPS URL with no embedded credentials or custom port.', checkedUrl.errorCode || 'base_mcp_x402_url_unsafe');
  }
  if (!approvedX402HostV1(checkedUrl.url)) {
    return failedWithoutReceipt('That x402 host is not in Miorail’s reviewed intelligence/provider allowlist.', 'base_mcp_x402_host_not_approved');
  }
  if (BigInt(input.intent.maxPaymentAtomic) > maximumX402AtomicV1()) {
    return failedWithoutReceipt(
      `The x402 cap exceeds this server’s action limit (${process.env.BASE_MCP_ACTION_X402_MAX_USDC || '1'} USDC).`,
      'base_mcp_x402_capability_limit_exceeded',
    );
  }
  if (!(await baseMcpExtensionActionRuntime.repository.available())) {
    return failedWithoutReceipt('Action Receipt storage is unavailable, so no x402 payment was prepared.', 'base_mcp_action_storage_unavailable');
  }
  const screening = baseMcpExtensionActionRuntime.screenAction({ instruction: input.message });
  if (!screening.allowed) {
    return failedWithoutReceipt('The x402 request did not pass the action safety policy.', 'base_mcp_x402_safety_check_failed');
  }

  const walletAddress = input.walletAddress.toLowerCase() as `0x${string}`;
  const intent: BaseMcpX402ActionIntentV1 = { ...input.intent, url: checkedUrl.url };
  const now = baseMcpExtensionActionRuntime.now();
  const created = await baseMcpExtensionActionRuntime.repository.create({
    tenantId: input.userId,
    walletAddress,
    idempotencyKey: input.idempotencyKey,
    actionType: 'x402',
    intent,
    now,
  });
  if (!created.created) {
    const expectedHash = baseMcpActionHashV1({
      tenantId: input.userId,
      walletAddress,
      idempotencyKey: input.idempotencyKey,
      actionType: 'x402',
      intent,
    });
    if (created.receipt.actionHash !== expectedHash) return idempotencyConflictResult(created.receipt);
    return publicResult(
      created.receipt,
      null,
      created.receipt.status === 'preparing'
        ? 'This idempotent x402 request already started and its first response is uncertain. Miorail will not initiate a second payment.'
        : 'This idempotent x402 request already exists. Its Action Receipt was returned without initiating another payment.',
      created.receipt.status === 'preparing' ? 'base_mcp_action_outcome_unknown' : created.receipt.errorCode,
    );
  }

  let tools: ToolAggregator;
  try {
    tools = await createExtensionTools({
      ...input,
      allowedActionTools: ['initiate_x402_request', 'complete_x402_request'],
    });
  } catch {
    const failed = await baseMcpExtensionActionRuntime.repository.update({
      id: created.receipt.id,
      tenantId: input.userId,
      status: 'failed',
      reconciliationState: 'not_started',
      errorCode: 'base_mcp_connect_failed',
      finalizedAt: now,
      now,
    });
    return publicResult(failed!, null, 'Base MCP could not be reached. No x402 approval request was returned.', 'base_mcp_connect_failed');
  }

  try {
    const inventory = await tools.listProviderTools();
    if (inventory.some((entry) => !entry.providerId.startsWith('base-mcp'))) {
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode: 'non_base_mcp_provider_registered',
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'The Extensions action boundary refused a non-Base-MCP provider.', 'non_base_mcp_provider_registered');
    }
    const toolsAvailable = inventory.reduce((total, entry) => total + entry.tools.length, 0);
    const tool = exactTool(inventory, 'initiatex402request');
    if (!tool) {
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode: 'base_mcp_x402_unavailable',
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'Base MCP did not expose initiate_x402_request.', 'base_mcp_x402_unavailable', toolsAvailable);
    }

    const walletMatch = await baseMcpExtensionActionRuntime.verifyWallet(tools, walletAddress);
    if (!walletMatch.checked || !walletMatch.match) {
      const errorCode = walletMatch.checked ? BASE_MCP_WALLET_MISMATCH_ERROR_CODE : BASE_MCP_WALLET_UNVERIFIED_ERROR_CODE;
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode,
        finalizedAt: now,
        now,
      });
      return publicResult(
        failed!,
        null,
        walletMatch.checked ? BASE_MCP_WALLET_MISMATCH_MESSAGE : BASE_MCP_WALLET_UNVERIFIED_MESSAGE,
        errorCode,
        toolsAvailable,
      );
    }

    let called: { content: string; isError: boolean };
    try {
      called = await tools.callTool(tool.name, x402Args(tool, intent));
    } catch {
      called = { content: JSON.stringify({ errorCode: 'base_mcp_x402_initiate_failed' }), isError: true };
    }
    if (called.isError) {
      const errorCode = sanitizedToolErrorCode(called.content, 'base_mcp_x402_initiate_failed');
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        errorCode,
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'Base MCP did not prepare the x402 payment.', errorCode, toolsAvailable);
    }

    const snapshot = extractBaseMcpApprovalSnapshot(called.content);
    if (!snapshot.requestId) {
      const failed = await baseMcpExtensionActionRuntime.repository.update({
        id: created.receipt.id,
        tenantId: input.userId,
        status: 'failed',
        reconciliationState: 'not_started',
        durableProof: durableProofRecord(snapshot.proof),
        errorCode: 'base_mcp_request_id_missing',
        finalizedAt: now,
        now,
      });
      return publicResult(failed!, null, 'Base MCP returned no durable request ID, so Miorail withheld the x402 approval link.', 'base_mcp_request_id_missing', toolsAvailable);
    }
    const state: BaseMcpApprovalState = snapshot.state || (snapshot.approvalUrl ? 'approval_required' : 'pending');
    const receipt = await baseMcpExtensionActionRuntime.repository.update({
      id: created.receipt.id,
      tenantId: input.userId,
      status: state === 'completed' ? 'reconciling' : state,
      reconciliationState: state === 'completed' ? 'pending' : 'not_started',
      providerRequestId: snapshot.requestId,
      durableProof: durableProofRecord(snapshot.proof),
      errorCode: null,
      ...(terminal(state) && state !== 'completed' ? { finalizedAt: now } : {}),
      now,
    });
    if (!receipt) return failedWithoutReceipt('The x402 Action Receipt could not be updated.', 'base_mcp_action_storage_failed');
    return publicResult(
      receipt,
      snapshot.approvalUrl ?? null,
      snapshot.approvalUrl
        ? `Base MCP prepared an x402 GET capped at ${intent.maxPayment} USDC. Review the exact payment in Base Account.`
        : 'The x402 approval request is pending. Check its Action Receipt after acting in Base Account.',
      receipt.errorCode,
      toolsAvailable,
    );
  } finally {
    await tools.close().catch(() => undefined);
  }
}

export async function reconcileBaseMcpActionV1(input: {
  req: Request;
  userId: string;
  walletAddress?: string;
  sessionSecret: string;
  receiptId: string;
}): Promise<BaseMcpExtensionActionResultV1> {
  const found = await baseMcpExtensionActionRuntime.repository.get(input.receiptId, input.userId);
  if (!found) return failedWithoutReceipt('That Action Receipt was not found for this account.', 'base_mcp_action_receipt_not_found');
  if (found.actionType === 'virtuals') {
    return reconcileBaseMcpVirtualsActionV1({ ...input, receipt: found });
  }
  const stored = await expireStaleBaseMcpX402ReceiptV1(found, baseMcpExtensionActionRuntime.now());
  if (['completed', 'rejected', 'failed'].includes(stored.status)) {
    return publicResult(stored, null, 'This Action Receipt is already final.', stored.errorCode);
  }
  if (!stored.providerRequestId) {
    return publicResult(stored, null, 'The original Base MCP outcome is uncertain and has no request ID. Miorail will not prepare another transfer.', 'base_mcp_action_outcome_unknown');
  }
  if (!input.walletAddress || input.walletAddress.toLowerCase() !== stored.walletAddress) {
    return publicResult(stored, null, 'Connect the same Base Account that created this action before checking it.', 'base_mcp_action_wallet_mismatch');
  }

  let tools: ToolAggregator;
  try {
    tools = await createExtensionTools({
      ...input,
      ...(stored.actionType === 'x402'
        ? { allowedActionTools: ['complete_x402_request'] }
        : {}),
    });
  } catch {
    return publicResult(stored, null, 'Base MCP could not be reached. The receipt remains pending.', 'base_mcp_connect_failed');
  }
  try {
    const walletMatch = await baseMcpExtensionActionRuntime.verifyWallet(tools, stored.walletAddress);
    if (!walletMatch.checked || !walletMatch.match) {
      return publicResult(
        stored,
        null,
        walletMatch.checked ? BASE_MCP_WALLET_MISMATCH_MESSAGE : BASE_MCP_WALLET_UNVERIFIED_MESSAGE,
        walletMatch.checked ? BASE_MCP_WALLET_MISMATCH_ERROR_CODE : BASE_MCP_WALLET_UNVERIFIED_ERROR_CODE,
      );
    }
    const outcome = await resolveBaseMcpApprovalLifecycle({
      initialResult: {
        requestId: stored.providerRequestId,
        ...(stored.durableProof || {}),
      },
      tools,
      pollAttempts: 1,
    });
    const now = baseMcpExtensionActionRuntime.now();
    const proof = { ...(stored.durableProof || {}), ...(outcome.proof || {}) } as BaseMcpDurableProof;
    let receipt: StoredBaseMcpActionReceiptV1;
    let resultPreview: string | null = null;
    if (outcome.state === 'completed' && stored.actionType === 'x402') {
      const inventory = await tools.listProviderTools();
      const completeTool = exactTool(inventory, 'completex402request');
      if (!completeTool) {
        receipt = (await baseMcpExtensionActionRuntime.repository.update({
          id: stored.id,
          tenantId: stored.tenantId,
          status: 'reconciling',
          reconciliationState: 'pending',
          durableProof: durableProofRecord(proof),
          errorCode: 'base_mcp_x402_complete_unavailable',
          now,
        }))!;
      } else {
        let completed: { content: string; isError: boolean };
        try {
          completed = await tools.callTool(
            completeTool.name,
            completeX402Args(completeTool, stored.providerRequestId),
          );
        } catch {
          completed = { content: JSON.stringify({ errorCode: 'base_mcp_x402_complete_failed' }), isError: true };
        }
        if (completed.isError) {
          receipt = (await baseMcpExtensionActionRuntime.repository.update({
            id: stored.id,
            tenantId: stored.tenantId,
            status: 'reconciling',
            reconciliationState: 'pending',
            durableProof: durableProofRecord(proof),
            errorCode: sanitizedToolErrorCode(completed.content, 'base_mcp_x402_complete_failed'),
            now,
          }))!;
        } else {
          resultPreview = boundedX402PreviewV1(completed.content);
          receipt = (await baseMcpExtensionActionRuntime.repository.update({
            id: stored.id,
            tenantId: stored.tenantId,
            status: 'completed',
            reconciliationState: 'provider_confirmed',
            durableProof: durableProofRecord(proof),
            responseHash: stableHashV1('base-mcp-x402-response/v1', completed.content),
            errorCode: null,
            finalizedAt: now,
            now,
          }))!;
        }
      }
    } else if (outcome.state === 'completed') {
      receipt = await reconcileCompletedReceipt({ receipt: stored, proof, now });
    } else if (outcome.state === 'rejected' || outcome.state === 'failed') {
      receipt = (await baseMcpExtensionActionRuntime.repository.update({
        id: stored.id,
        tenantId: stored.tenantId,
        status: outcome.state,
        reconciliationState: 'not_started',
        durableProof: durableProofRecord(proof),
        errorCode: outcome.errorCode || `base_mcp_${outcome.state}`,
        finalizedAt: now,
        now,
      }))!;
    } else {
      receipt = (await baseMcpExtensionActionRuntime.repository.update({
        id: stored.id,
        tenantId: stored.tenantId,
        status: outcome.state,
        reconciliationState: stored.reconciliationState,
        durableProof: durableProofRecord(proof),
        errorCode: outcome.errorCode ?? null,
        now,
      }))!;
    }
    const reply = receipt.status === 'completed'
      ? receipt.actionType === 'x402'
        ? 'The approved x402 request completed and the paid endpoint returned a response. Miorail stored only its hash.'
        : 'Confirmed and reconciled: the exact expected USDC Transfer event was observed on Base.'
      : receipt.status === 'reconciling'
        ? 'Base MCP reports completion, but the exact onchain transfer is not matched yet.'
        : receipt.status === 'rejected'
          ? 'The Base Account approval was rejected.'
          : receipt.status === 'failed'
            ? 'The Base MCP action failed or its onchain facts did not match the request.'
            : 'The Base Account approval is still pending.';
    return publicResult(receipt, outcome.approvalUrl ?? null, reply, receipt.errorCode, 0, resultPreview);
  } finally {
    await tools.close().catch(() => undefined);
  }
}

export async function listBaseMcpActionReceiptsV1(userId: string, limit = 20) {
  if (!(await baseMcpExtensionActionRuntime.repository.available())) {
    throw new Error('base_mcp_action_storage_unavailable');
  }
  const rows = await baseMcpExtensionActionRuntime.repository.list(userId, limit);
  const now = baseMcpExtensionActionRuntime.now();
  const finalized = await Promise.all(rows.map((receipt) => expireStaleBaseMcpX402ReceiptV1(receipt, now)));
  return finalized.map(publicBaseMcpActionReceiptV1);
}
