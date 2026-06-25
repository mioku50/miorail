import { screenAction } from './index.js'; // Since screenAction is in index.js for now, avoiding circular deps by importing from a separate file later if needed. For now, leaving as index.js as it contains the definition.

export interface SimulationCall {
  to: string;
  value?: string;
  data?: string;
}

export interface SimulationInput {
  chain: string;
  calls: SimulationCall[];
  instruction?: string;
}

export interface SimulationResult {
  success: boolean; // keep the backward compatibility with what we injected earlier
  allowed: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
  reason?: string;
  error?: string; // mapping reason to error for caller
  estimatedGas?: string;
  expectedOutput?: string;
  checks: string[];
}

export async function simulateTrade(input: SimulationInput | string, legacyCalls?: SimulationCall[]): Promise<SimulationResult> {
  // Support legacy signature (chain, calls) we injected in tools
  let chain: string;
  let calls: SimulationCall[];
  let instruction = '';

  if (typeof input === 'string') {
    chain = input;
    calls = legacyCalls || [];
  } else {
    chain = input.chain;
    calls = input.calls || [];
    instruction = input.instruction || '';
  }

  const result: SimulationResult = {
    success: false,
    allowed: false,
    riskLevel: 'blocked',
    checks: [],
  };

  // 1. Validate chain
  if (chain !== 'eip155:84532' && chain !== '84532' && chain !== 'base') {
    result.reason = 'Simulation failed: Unsupported chain';
    result.error = result.reason;
    result.checks.push('Chain validation: Failed');
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
    const screenRes = screenAction({ instruction });
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

  // 4. Validate Token Addresses (Base Sepolia Canonical USDC only)
  const canonicalUSDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  for (const call of calls) {
    if (call.data && (call.data.toLowerCase().startsWith('0x095ea7b3') || call.data.toLowerCase().startsWith('0xa9059cbb'))) {
        if (call.to.toLowerCase() !== canonicalUSDC) {
            result.reason = 'Simulation failed: Invalid token address. Only canonical USDC on Base Sepolia is supported.';
            result.error = result.reason;
            result.checks.push('Token validation: Failed');
            return result;
        }
    }
  }
  result.checks.push('Token validation: Passed');

  // If we reach here, it's allowed and mock success
  result.success = true;
  result.allowed = true;
  result.riskLevel = 'low';
  result.estimatedGas = '21000';
  result.expectedOutput = 'Simulated success';
  result.checks.push('Mock execution simulation: Passed');

  return result;
}
