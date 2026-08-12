export interface ScreenableAction {
  instruction: string;
  memoryMd?: string | null;
  providerContext?: {
    risk?: string;
    riskProvider?: string;
    securityProvider?: string;
    requiresTokenSecurity?: boolean;
  };
}

export interface SecurityCheck {
  name: string;
  status: 'PASSED' | 'BLOCKED' | 'SKIPPED';
}

export interface ScreenResult {
  allowed: boolean;
  reason?: string;
  checks?: SecurityCheck[];
}

function deobfuscate(text: string): string {
  let s = text.normalize('NFKC');
  // Remove zero-width chars and soft hyphens
  s = s.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  s = s.toLowerCase();
  // Remove non-alphanumeric separators (spaces, dashes, underscores, dots)
  s = s.replace(/[\s\-_.]/g, '');
  // Undo leetspeak
  s = s.replace(/[0@]/g, 'o')
       .replace(/[1!]/g, 'i')
       .replace(/3/g, 'e')
       .replace(/4/g, 'a')
       .replace(/5/g, 's')
       .replace(/7/g, 't')
       .replace(/8/g, 'b');
  return s;
}

function buildChecks(failedCheck?: string, goPlusRan?: boolean): SecurityCheck[] {
  const goPlusStatus: 'PASSED' | 'BLOCKED' | 'SKIPPED' =
    failedCheck === 'goplus' ? 'BLOCKED' : goPlusRan ? 'PASSED' : 'SKIPPED';
  return [
    { name: 'Prompt Injection / Jailbreak', status: failedCheck === 'prompt' ? 'BLOCKED' : 'PASSED' },
    { name: 'Credential Exfiltration', status: failedCheck === 'exfil' ? 'BLOCKED' : 'PASSED' },
    { name: 'Wallet Drain / Sweep', status: failedCheck === 'drain' ? 'BLOCKED' : 'PASSED' },
    { name: 'Unlimited Token Approval', status: failedCheck === 'approval' ? 'BLOCKED' : 'PASSED' },
    { name: 'User Memory Policy', status: failedCheck === 'memory' ? 'BLOCKED' : 'PASSED' },
    { name: 'GoPlus Contract Security', status: goPlusStatus }
  ];
}

function memoryPolicyBlocks(rawInstruction: string, cleanInstruction: string, memoryMd?: string | null): string | null {
  if (!memoryMd) return null;
  const lowerInstruction = rawInstruction.toLowerCase();
  const policyLines = memoryMd
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\b(never|do not|don't|dont|no|block|forbid|forbidden|avoid|disallow)\b/i.test(line));

  const actionTerms = [
    'approve', 'approval', 'allowance', 'authorize', 'permission',
    'send', 'transfer', 'withdraw', 'swap', 'bridge', 'leverage',
    'borrow', 'lend', 'deposit',
  ];
  for (const line of policyLines) {
    const cleanLine = deobfuscate(line);
    const addresses = line.match(/0x[a-fA-F0-9]{40}/g) || [];
    for (const address of addresses) {
      if (lowerInstruction.includes(address.toLowerCase())) {
        return `User memory policy blocks address ${address}`;
      }
    }

    for (const term of actionTerms) {
      if (cleanLine.includes(term) && cleanInstruction.includes(term)) {
        return `User memory policy blocks ${term}`;
      }
    }
  }
  return null;
}

export function screenAction(a: ScreenableAction): ScreenResult {
  const raw = a.instruction;
  const clean = deobfuscate(raw);
  const securityProvider = a.providerContext?.securityProvider || a.providerContext?.riskProvider;
  const riskStatus = a.providerContext?.risk;
  const goPlusRan = securityProvider === 'goplus' && (riskStatus === 'connected' || riskStatus === 'ok' || riskStatus === 'partial');

  if (a.providerContext?.requiresTokenSecurity && !goPlusRan) {
    const reason = securityProvider === 'goplus'
      ? 'Contract security check is temporarily unavailable'
      : 'Contract security checks are required for this action';
    return { allowed: false, reason, checks: buildChecks('goplus', false) };
  }

  const memoryBlock = memoryPolicyBlocks(raw, clean, a.memoryMd);
  if (memoryBlock) {
    return { allowed: false, reason: memoryBlock, checks: buildChecks('memory', goPlusRan) };
  }

  // 1. Prompt injection / jailbreaks
  const promptInjections = [
    'ignorepreviousinstructions',
    'developermode',
    'revealyoursystemprompt'
  ];
  for (const p of promptInjections) {
    if (clean.includes(p)) {
      return { allowed: false, reason: 'Prompt injection detected', checks: buildChecks('prompt', goPlusRan) };
    }
  }

  // 2. Credential exfiltration
  const exfilPatterns = [
    'seedphrase',
    'privatekey'
  ];
  for (const p of exfilPatterns) {
    if (clean.includes(p)) {
      return { allowed: false, reason: 'Credential exfiltration detected', checks: buildChecks('exfil', goPlusRan) };
    }
  }

  // 3. Wallet drain
  const drainActions = ['send', 'transfer', 'withdraw', 'sweep', 'drain', 'move', 'empty'];
  const exactDrainTargets = ['all', 'everything', '100%'];
  const semanticDrainTargets = [
    'entirebalance',
    'fullbalance',
    'wholebalance',
    'completebalance',
    'allfunds',
    'allassets',
    'everytoken',
    'entirewallet',
    'allmyfunds',
    'myentirebalance',
  ];

  for (const action of drainActions) {
    for (const target of exactDrainTargets) {
      if (clean.includes(action + target)) {
        return { allowed: false, reason: 'Wallet drain detected', checks: buildChecks('drain', goPlusRan) };
      }
    }
    if (clean.includes(action) && semanticDrainTargets.some((target) => clean.includes(target))) {
      return { allowed: false, reason: 'Wallet drain detected', checks: buildChecks('drain', goPlusRan) };
    }
  }

  // Special case: just "drain" or "sweep" might be enough, but let's stick to combinations or explicit drainall
  if (clean.includes('drainwallet') || clean.includes('sweepwallet')) {
    return { allowed: false, reason: 'Wallet drain detected', checks: buildChecks('drain', goPlusRan) };
  }

  // 4. Unlimited token approval
  const approvalIntent = ['approve', 'approval', 'authorize', 'permission', 'spend', 'spending', 'allowance'].some((term) => clean.includes(term));
  const unlimitedIntent = [
    'unlimitedapproval',
    'approveunlimited',
    'infiniteapproval',
    'approveinfinite',
    'maxapproval',
    'withoutlimit',
    'nolimit',
    'nolimits',
    'anyamount',
    'everytoken',
    'alltokens',
    'useeverytoken',
  ].some((term) => clean.includes(term));
  if (unlimitedIntent && (approvalIntent || clean.includes('maxapproval'))) {
    return { allowed: false, reason: 'Unlimited token approval detected', checks: buildChecks('approval', goPlusRan) };
  }

  return { allowed: true, checks: buildChecks(undefined, goPlusRan) };
}
export * from './payment-policy.js';
export * from './budget.js';
export * from './simulation.js';
export * from './baseGuards.js';
export * from './executionGuard.js';
export * from './httpAllowlist.js';
export * from './baseMcpPluginCatalogue.generated.js';
export * from './baseMcpProviderIntents.js';
export * from './moonwellGuard.js';
export * from './swapAsset.js';
export * from './uniswapGuard.js';
export * from './kyberGuard.js';
export * from './aerodromeGuard.js';
