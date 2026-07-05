import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

export const CONTROLLER_ABI = parseAbi([
  'function getPermission(address owner, address executor, address token) external view returns ((address owner, address executor, address token, uint256 dailyLimit, uint256 maxPerAction, uint64 validAfter, uint64 validUntil, bool revoked, address[] whitelist, uint256 spentToday, uint64 dayStart, uint256 nonce))',
  'function configurePermission(address executor, address token, uint256 dailyLimit, uint256 maxPerAction, uint64 validAfter, uint64 validUntil, address[] whitelist) external',
  'function revokePermission(address executor, address token) external',
  'function executeSpend(address owner, address token, address target, uint256 amount) external returns (bool)'
]);

export function getBaseSepoliaControllerAddress(): Hex | null {
  const addr = process.env.BASE_SEPOLIA_SPEND_PERMISSION_CONTROLLER_ADDRESS || process.env.BASE_SEPOLIA_CONTROLLER_ADDRESS;
  if (!addr || !addr.startsWith('0x') || addr === '0x0000000000000000000000000000000000000000') {
    return null;
  }
  return addr as Hex;
}

export function getBaseSepoliaUsdcAddress(): Hex {
  const addr = process.env.BASE_SEPOLIA_USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  return addr as Hex;
}

export function isTestnetAutonomyEnabled(): boolean {
  return process.env.ENABLE_TESTNET_AUTONOMY === 'true';
}

function getRpcUrl(): string {
  return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
}

export function getPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(getRpcUrl())
  });
}

export function getWalletClient() {
  const pk = process.env.TESTNET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!pk || !pk.startsWith('0x')) {
    return null;
  }
  const account = privateKeyToAccount(pk as Hex);
  return {
    account,
    client: createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(getRpcUrl())
    })
  };
}

export async function readOnchainPermission(owner: Hex, executor: Hex, token?: Hex) {
  const contractAddress = getBaseSepoliaControllerAddress();
  if (!contractAddress) return null;

  const tokenAddr = token || getBaseSepoliaUsdcAddress();
  const publicClient = getPublicClient();

  try {
    const perm = await publicClient.readContract({
      address: contractAddress,
      abi: CONTROLLER_ABI,
      functionName: 'getPermission',
      args: [owner, executor, tokenAddr]
    });

    if (!perm || !perm.owner || perm.owner === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    return perm;
  } catch (err) {
    return null;
  }
}

export async function executeTestnetConfigureOnchain(
  executor: Hex | null,
  token: Hex | null,
  dailyLimitUsdc: string,
  maxPerActionUsdc: string,
  ttlSeconds: number,
  whitelist: Hex[]
): Promise<string | null> {
  const contractAddress = getBaseSepoliaControllerAddress();
  if (!contractAddress || !executor || !token) return null;

  const wallet = getWalletClient();
  if (!wallet) return null;

  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now);
  const validUntil = BigInt(now + ttlSeconds);
  const dailyLimit = parseUnits(dailyLimitUsdc, 6);
  const maxPerAction = parseUnits(maxPerActionUsdc, 6);

  try {
    const hash = await wallet.client.writeContract({
      address: contractAddress,
      abi: CONTROLLER_ABI,
      functionName: 'configurePermission',
      args: [executor, token, dailyLimit, maxPerAction, validAfter, validUntil, whitelist]
    });
    return hash;
  } catch (err) {
    console.error('Error executing testnet configure onchain:', err);
    return null;
  }
}

export async function executeTestnetRevokeOnchain(
  executor: Hex | null,
  token: Hex | null
): Promise<string | null> {
  const contractAddress = getBaseSepoliaControllerAddress();
  if (!contractAddress || !executor || !token) return null;

  const wallet = getWalletClient();
  if (!wallet) return null;

  try {
    const hash = await wallet.client.writeContract({
      address: contractAddress,
      abi: CONTROLLER_ABI,
      functionName: 'revokePermission',
      args: [executor, token]
    });
    return hash;
  } catch (err) {
    console.error('Error executing testnet revoke onchain:', err);
    return null;
  }
}

export async function executeTestnetSpendOnchain(
  owner: Hex | null,
  token: Hex | null,
  target: Hex | null,
  amountUsdc: string
): Promise<string | null> {
  const contractAddress = getBaseSepoliaControllerAddress();
  if (!contractAddress || !owner || !token || !target) return null;

  const wallet = getWalletClient();
  if (!wallet) return null;

  const amount = parseUnits(amountUsdc, 6);

  try {
    const hash = await wallet.client.writeContract({
      address: contractAddress,
      abi: CONTROLLER_ABI,
      functionName: 'executeSpend',
      args: [owner, token, target, amount]
    });
    return hash;
  } catch (err) {
    console.error('Error executing testnet spend onchain:', err);
    throw err;
  }
}
