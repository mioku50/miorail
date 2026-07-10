import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

export const CONTROLLER_ABI = parseAbi([
  'function getPermission(address owner, address executor, address token) external view returns ((address owner, address executor, address token, uint256 dailyLimit, uint256 maxPerAction, uint64 validAfter, uint64 validUntil, bool revoked, address[] whitelist, uint256 spentToday, uint64 dayStart, uint256 nonce))',
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
  } catch {
    return null;
  }
}
