export interface ScreenableAction {
  instruction: string;
}

export interface ScreenResult {
  allowed: boolean;
  reason?: string;
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

export function screenAction(a: ScreenableAction): ScreenResult {
  const raw = a.instruction;
  const clean = deobfuscate(raw);

  // 1. Prompt injection / jailbreaks
  const promptInjections = [
    'ignorepreviousinstructions',
    'developermode',
    'revealyoursystemprompt'
  ];
  for (const p of promptInjections) {
    if (clean.includes(p)) {
      return { allowed: false, reason: 'Prompt injection detected' };
    }
  }

  // 2. Credential exfiltration
  const exfilPatterns = [
    'seedphrase',
    'privatekey'
  ];
  for (const p of exfilPatterns) {
    if (clean.includes(p)) {
      return { allowed: false, reason: 'Credential exfiltration detected' };
    }
  }

  // 3. Wallet drain
  const drainActions = ['send', 'transfer', 'withdraw', 'sweep', 'drain'];
  const drainTargets = ['all', 'everything', '100%'];

  for (const action of drainActions) {
    for (const target of drainTargets) {
      if (clean.includes(action + target)) {
        return { allowed: false, reason: 'Wallet drain detected' };
      }
    }
  }

  // Special case: just "drain" or "sweep" might be enough, but let's stick to combinations or explicit drainall
  if (clean.includes('drainwallet') || clean.includes('sweepwallet')) {
    return { allowed: false, reason: 'Wallet drain detected' };
  }

  // 4. Unlimited token approval
  if (clean.includes('unlimitedapproval') || clean.includes('approveunlimited') || clean.includes('infiniteapproval') || clean.includes('approveinfinite') || clean.includes('maxapproval')) {
    return { allowed: false, reason: 'Unlimited token approval detected' };
  }

  return { allowed: true };
}
export * from './payment-policy.js';
export * from './budget.js';
export * from './simulation.js';
