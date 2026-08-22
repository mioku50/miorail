// ---------------------------------------------------------------------------
// What a provider operation still needs from the user.
//
// `requires_input` and `unsupported` were one answer, and they are not one
// fact. Brickken is the case that shows it: `agentRegister` is a fully
// specified operation — its plugin spec names exactly four required fields —
// and the console answered
//
//   "brickken uses a provider-specific prepare response before x402 payment.
//    The question is recognized, but Miorail will not substitute a generic URL
//    for those quoted payment requirements."
//
// which is true, unhelpful, and indistinguishable from "we cannot do this".
// A user who reads it has no idea that supplying a name, a description, a logo
// URL and one service would have been enough.
//
// So the required fields live here, from the plugin spec, and a request that
// is missing some is answered by naming THOSE — never by describing the
// payment architecture.
//
// This module reads the user's own words and nothing else. It never invents a
// value, never substitutes a placeholder, and never reaches a provider.
// ---------------------------------------------------------------------------

export interface RequiredFieldV1 {
  id: string;
  /** What to call it when asking. */
  label: string;
  /** One clause on what a good value looks like. */
  hint: string;
  /** Recognises the field in the user's message. Absence is not an error. */
  present: (message: string) => boolean;
}

export interface ProviderOperationSpecV1 {
  pluginId: string;
  operationId: string;
  /** The provider's own name for it, quoted back so the user can look it up. */
  providerMethod: string;
  fields: readonly RequiredFieldV1[];
}

const HTTPS_URL_V1 = /https:\/\/[^\s<>"']+\.[^\s<>"']+/iu;
/** A quoted phrase or a `called X` / `named X` clause — how people name things. */
const NAMED_V1 = /["“”'«»]([^"“”'«»]{2,60})["“”'«»]|\b(?:called|named|назван|под\s+именем)\s+([\p{L}\p{N}][\p{L}\p{N} ._-]{1,60})/iu;

export const BASE_MCP_REQUIRED_INPUTS_V1: readonly ProviderOperationSpecV1[] = [
  {
    pluginId: 'brickken',
    operationId: 'register',
    providerMethod: 'agentRegister',
    fields: [
      {
        id: 'name',
        label: 'agent name',
        hint: 'the name to register, in quotes',
        present: (message) => NAMED_V1.test(message),
      },
      {
        id: 'description',
        label: 'description',
        hint: 'one sentence on what the agent does',
        present: (message) => /\b(?:that|which|to|for|does|описан|котор|чтобы)\b[^.]{12,}/iu.test(message),
      },
      {
        id: 'image',
        label: 'logo URL',
        hint: 'a publicly reachable https:// image — Miorail will not substitute one',
        present: (message) => HTTPS_URL_V1.test(message),
      },
      {
        id: 'services',
        label: 'at least one service',
        hint: 'a service name, what it does, and its https:// endpoint',
        present: (message) => /\bservices?\b|\bendpoint\b|\bсервис/iu.test(message) && HTTPS_URL_V1.test(message),
      },
    ],
  },
  {
    pluginId: 'brickken',
    operationId: 'wallet',
    providerMethod: 'agentSetWallet',
    fields: [
      {
        id: 'agent',
        label: 'which agent',
        hint: 'its Brickken agent id or uuid',
        present: (message) => /\b(?:agent\s*(?:id|uuid)|uuid)\b/iu.test(message) || /\b[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(message),
      },
      {
        id: 'wallet',
        label: 'the Base wallet address',
        hint: 'the 0x… address to set as the operational wallet',
        present: (message) => /0x[a-fA-F0-9]{40}/u.test(message),
      },
    ],
  },
  {
    pluginId: 'brickken',
    operationId: 'transfer',
    providerMethod: 'agentTransferOwnership',
    fields: [
      {
        id: 'agent',
        label: 'which agent',
        hint: 'its Brickken agent id or uuid',
        present: (message) => /\b(?:agent\s*(?:id|uuid)|uuid)\b/iu.test(message) || /\b[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(message),
      },
      {
        id: 'newOwner',
        label: 'the receiving wallet',
        hint: 'the 0x… address that should own the agent NFT',
        present: (message) => /0x[a-fA-F0-9]{40}/u.test(message),
      },
    ],
  },
  {
    pluginId: 'venice',
    operationId: 'top-up',
    providerMethod: 'x402 balance top-up',
    fields: [
      {
        id: 'amount',
        label: 'the USDC amount',
        hint: 'an exact figure, for example 5 USDC',
        present: (message) => /\b\d+(?:[.,]\d{1,6})?\s*usdc\b/iu.test(message),
      },
    ],
  },
];

export interface MissingInputResultV1 {
  spec: ProviderOperationSpecV1;
  missing: readonly RequiredFieldV1[];
}

/** The operation's required fields the message does not supply. */
export function missingProviderInputsV1(
  pluginId: string,
  operationId: string | null | undefined,
  message: string,
): MissingInputResultV1 | null {
  const spec = BASE_MCP_REQUIRED_INPUTS_V1.find(
    (entry) => entry.pluginId === pluginId && entry.operationId === operationId,
  );
  if (!spec) return null;
  return { spec, missing: spec.fields.filter((field) => !field.present(message)) };
}

/**
 * The sentence a user can act on: the operation, the fields it still needs,
 * and an explicit statement that nothing was called or paid.
 */
export function missingInputsReplyV1(result: MissingInputResultV1): string {
  const list = result.missing.map((field) => `${field.label} (${field.hint})`).join('; ');
  return [
    `Miorail can prepare ${result.spec.providerMethod} on ${result.spec.pluginId}, and it still needs: ${list}.`,
    'Give those and it will ask the provider to prepare the operation; the payment terms then come from the provider and are shown before anything is approved.',
    'Nothing was sent, prepared or paid for this request.',
  ].join(' ');
}
