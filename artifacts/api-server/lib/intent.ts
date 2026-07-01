export interface ActionIntent {
  isActionIntent: boolean;
  intentType?: 'portfolio' | 'risk' | 'rebalance' | 'security' | 'yield' | 'general_recommendation';
  title?: string;
  reason?: string;
  expectedEffect?: string;
  risk?: 'low' | 'medium' | 'high' | 'unknown';
}

export function detectActionIntent(message: string): ActionIntent {
  const lower = message.trim().toLowerCase();

  // Check for greetings and normal chat that shouldn't trigger an action
  const greetings = ['hello', 'hi', 'hey', 'hi there', 'hello there', 'hey there', 'good morning', 'good afternoon', 'good evening', 'who are you?', 'what can you do?', 'help', 'thanks', 'thank you'];
  if (greetings.includes(lower) || lower.startsWith('hello ') || lower.startsWith('hi ') || lower.startsWith('hey ')) {
    if (!lower.includes('token') && !lower.includes('portfolio') && !lower.includes('risk') && !lower.includes('rebalance') && !lower.includes('swap') && !lower.includes('approval') && !lower.includes('permission') && !lower.includes('yield') && !lower.includes('liquidity') && !lower.includes('monitor')) {
      return { isActionIntent: false };
    }
  }

  if (lower.includes('approval') || lower.includes('permission') || lower.includes('revoke') || lower.includes('suspicious') || lower.includes('unauthorized') || lower.includes('watch for')) {
    return {
      isActionIntent: true,
      intentType: 'security',
      title: 'Security & Permission Monitoring',
      reason: `Automated recommendation created by Agent Stream to monitor spend permissions and watch for suspicious approvals: "${message}"`,
      expectedEffect: 'Scan connected wallet permissions and flag unauthorized or suspicious spend allowances.',
      risk: 'low'
    };
  }

  if (lower.includes('yield') || lower.includes('liquidity pool') || lower.includes('earn')) {
    return {
      isActionIntent: true,
      intentType: 'yield',
      title: 'Yield Opportunity Report',
      reason: `Automated recommendation created by Agent Stream to scan for yield opportunities: "${message}"`,
      expectedEffect: 'Analyze Base liquidity pools and generate a read-only yield opportunity report without executing transactions.',
      risk: 'low'
    };
  }

  if (lower.includes('rebalance') || lower.includes('swap') || lower.includes('plan') || lower.includes('create a recommendation') || lower.includes('recommendation')) {
    return {
      isActionIntent: true,
      intentType: 'rebalance',
      title: 'Portfolio Rebalance Plan',
      reason: `Automated recommendation created by Agent Stream to formulate a rebalance/swap plan: "${message}"`,
      expectedEffect: 'Formulate a read-only execution plan for swapping or rebalancing portfolio assets when conditions are safe.',
      risk: 'medium'
    };
  }

  if (lower.includes('token') || lower.includes('portfolio') || lower.includes('risky') || lower.includes('risk') || lower.includes('ignore or monitor') || lower.includes('check my') || lower.includes('analyze') || lower.includes('review')) {
    return {
      isActionIntent: true,
      intentType: 'portfolio',
      title: 'Token Risk & Portfolio Review',
      reason: `Automated recommendation created by Agent Stream to review portfolio and flag risky assets: "${message}"`,
      expectedEffect: 'Analyze Base token list, filter spam/airdrop tokens, and flag any high-risk assets.',
      risk: 'low'
    };
  }

  return { isActionIntent: false };
}
