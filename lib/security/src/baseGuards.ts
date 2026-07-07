export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_MAINNET_USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_SEPOLIA_USDC_DEFAULT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export type SupportedBaseChainId = typeof BASE_MAINNET_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID;

export interface NormalizedBaseChain {
  chainId: SupportedBaseChainId;
  caip2: `eip155:${SupportedBaseChainId}`;
  hexChainId: '0x2105' | '0x14a34';
  mcpChain: 'base' | 'base-sepolia';
  sendCallsTool: 'send_calls' | 'sepolia_send_calls';
}

export interface BaseCall {
  to: string;
  value?: string;
  data?: string;
}

export function getBaseMainnetUsdcAddress(): string {
  const value = process.env.BASE_MAINNET_USDC_ADDRESS || BASE_MAINNET_USDC_DEFAULT;
  return value;
}

export function getBaseSepoliaUsdcAddress(): string {
  const value = process.env.BASE_SEPOLIA_USDC_ADDRESS || BASE_SEPOLIA_USDC_DEFAULT;
  return value;
}

export function normalizeBaseChain(chain: string | number): NormalizedBaseChain {
  const raw = String(chain).trim().toLowerCase();
  if (raw === '8453' || raw === 'eip155:8453') {
    return {
      chainId: BASE_MAINNET_CHAIN_ID,
      caip2: 'eip155:8453',
      hexChainId: '0x2105',
      mcpChain: 'base',
      sendCallsTool: 'send_calls',
    };
  }
  if (raw === '84532' || raw === 'eip155:84532') {
    return {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      caip2: 'eip155:84532',
      hexChainId: '0x14a34',
      mcpChain: 'base-sepolia',
      sendCallsTool: 'sepolia_send_calls',
    };
  }
  throw new Error('Unsupported Base chain');
}

export function canonicalUsdcForBaseChain(chain: string | number): string {
  const normalized = normalizeBaseChain(chain);
  return normalized.chainId === BASE_MAINNET_CHAIN_ID
    ? getBaseMainnetUsdcAddress()
    : getBaseSepoliaUsdcAddress();
}

export function isErc20ApprovalOrTransferCalldata(data?: string): boolean {
  const normalized = data?.toLowerCase();
  return !!normalized && (normalized.startsWith('0x095ea7b3') || normalized.startsWith('0xa9059cbb'));
}

export function isNativeOrEmptyCalldata(data?: string): boolean {
  const normalized = data?.trim().toLowerCase();
  return !normalized || normalized === '0x';
}

export function validateBaseCalls(chain: string | number, calls: BaseCall[]): NormalizedBaseChain {
  const normalized = normalizeBaseChain(chain);
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('Missing or empty calls array');
  }

  const canonicalUsdc = canonicalUsdcForBaseChain(normalized.chainId).toLowerCase();
  for (const call of calls) {
    if (!call?.to) {
      throw new Error('Missing to address in call');
    }
    if (isNativeOrEmptyCalldata(call.data)) {
      continue;
    }
    if (!isErc20ApprovalOrTransferCalldata(call.data)) {
      throw new Error('Unsupported calldata. Only native calls or canonical USDC approve/transfer calldata are supported.');
    }
    if (call.to.toLowerCase() !== canonicalUsdc) {
      throw new Error(
        `Invalid token address. Only canonical USDC on Base ${normalized.chainId === BASE_MAINNET_CHAIN_ID ? 'Mainnet' : 'Sepolia'} is supported.`,
      );
    }
  }

  return normalized;
}
