import { screenAction } from './index.js'; // Since screenAction is in index.js for now, avoiding circular deps by importing from a separate file later if needed. For now, leaving as index.js as it contains the definition.
import { validateBaseCalls } from './baseGuards.js';

export interface SimulationCall {
  to: string;
  value?: string;
  data?: string;
}

export interface SimulationInput {
  chain: string;
  calls: SimulationCall[];
  instruction?: string;
  memoryMd?: string | null;
}

export interface SimulationResult {
  performed?: boolean;
  success: boolean; // keep the backward compatibility with what we injected earlier
  allowed: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
  reason?: string;
  error?: string; // mapping reason to error for caller
  estimatedGas?: string;
  expectedOutput?: string;
  checks: string[];
  // Honest label: this is preflight validation, NOT a fork simulation. For
  // supported ERC-20 calls it includes deterministic before/after projections
  // decoded from calldata; it does not execute or broadcast.
  method?: 'preflight-validation' | 'not-applicable';
  projections?: Array<{
    kind: 'erc20_approval' | 'erc20_transfer' | 'unknown';
    token: string;
    spender?: string;
    recipient?: string;
    amountRaw?: string;
    allowanceAfter?: string;
    balanceDelta?: string;
  }>;
}

function decodeAddress(word: string): string {
  return `0x${word.slice(24)}`;
}

function decodeUint256(word: string): string {
  try {
    return BigInt(`0x${word}`).toString();
  } catch {
    return '0';
  }
}

function buildCallProjections(calls: SimulationCall[]): SimulationResult['projections'] {
  return calls.map((call) => {
    const data = call.data?.toLowerCase();
    if (!data || data.length < 10 + 64) {
      return { kind: 'unknown', token: call.to };
    }

    const selector = data.slice(0, 10);
    const arg1 = data.slice(10, 74);
    const arg2 = data.slice(74, 138);
    if (selector === '0x095ea7b3' && arg1.length === 64 && arg2.length === 64) {
      const allowanceAfter = decodeUint256(arg2);
      return {
        kind: 'erc20_approval',
        token: call.to,
        spender: decodeAddress(arg1),
        amountRaw: allowanceAfter,
        allowanceAfter,
      };
    }
    if (selector === '0xa9059cbb' && arg1.length === 64 && arg2.length === 64) {
      const amountRaw = decodeUint256(arg2);
      return {
        kind: 'erc20_transfer',
        token: call.to,
        recipient: decodeAddress(arg1),
        amountRaw,
        balanceDelta: `-${amountRaw}`,
      };
    }

    return { kind: 'unknown', token: call.to };
  });
}

export async function preflightValidateAction(input: SimulationInput | string, legacyCalls?: SimulationCall[]): Promise<SimulationResult> {
  // Support legacy signature (chain, calls) we injected in tools
  let chain: string;
  let calls: SimulationCall[];
  let instruction = '';
  let memoryMd: string | null | undefined;

  if (typeof input === 'string') {
    chain = input;
    calls = legacyCalls || [];
  } else {
    chain = input.chain;
    calls = input.calls || [];
    instruction = input.instruction || '';
    memoryMd = input.memoryMd;
  }

  const result: SimulationResult = {
    success: false,
    allowed: false,
    riskLevel: 'blocked',
    checks: [],
    method: 'preflight-validation',
  };

  // 1. Validate chain — Base Sepolia testnet OR Base Mainnet. The user-confirmed
  // flow (T19) permits mainnet because the server never broadcasts; the wallet
  // signs. This validator only checks structure, it does not execute.
  try {
    validateBaseCalls(chain, calls);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.reason = `Simulation failed: ${message}`;
    result.error = result.reason;
    if (/missing|empty|to address/i.test(message)) {
      result.checks.push('Calls structure validation: Failed');
    } else if (/token address/i.test(message)) {
      result.checks.push('Token validation: Failed');
    } else {
      result.checks.push('Chain validation: Failed');
    }
    return result;
  }
  result.checks.push('Chain validation: Passed');

  // 2. Validate calls structure
  if (!calls || calls.length === 0) {
    result.reason = 'Simulation failed: No calls provided';
    result.error = result.reason;
    result.checks.push('Calls structure validation: Failed');
    return result;
  }

  for (const call of calls) {
    if (!call.to) {
      result.reason = 'Simulation failed: Missing target address (to)';
      result.error = result.reason;
      result.checks.push('Calls structure validation: Failed');
      return result;
    }
  }
  result.checks.push('Calls structure validation: Passed');

  // 3. Instruction screening (if provided)
  if (instruction) {
    const screenRes = screenAction({ instruction, memoryMd });
    if (!screenRes.allowed) {
      result.reason = `Simulation failed: Security screening blocked action. Reason: ${screenRes.reason}`;
      result.error = result.reason;
      result.checks.push(`Instruction screening: Failed (${screenRes.reason})`);
      return result;
    }
    result.checks.push('Instruction screening: Passed');
  } else {
      result.checks.push('Instruction screening: Skipped (no instruction provided)');
  }

  // 4. Validate Token Addresses — canonical USDC only (Sepolia testnet + Base
  // Mainnet native USDC). The mainnet address is env-overridable so a deployment
  // can pin a different token; default is Circle's native USDC on Base (6 decimals),
  // NOT the bridged USDbC.
  // Token validation was enforced by validateBaseCalls above.
  result.checks.push('Token validation: Passed');

  const projections = buildCallProjections(calls);

  // If we reach here, preflight validation passed. This is NOT a fork
  // simulation; projections are deterministic calldata decoding for supported
  // ERC-20 calls plus chain/call/security/canonical-token checks.
  result.success = true;
  result.allowed = true;
  result.riskLevel = 'low';
  result.estimatedGas = '21000';
  result.expectedOutput = 'Preflight validation passed (no fork simulation)';
  result.projections = projections;
  result.checks.push('Preflight validation (no fork sim): Passed');

  return result;
}

export async function simulateTrade(input: SimulationInput | string, legacyCalls?: SimulationCall[]): Promise<SimulationResult> {
  return preflightValidateAction(input, legacyCalls);
}
