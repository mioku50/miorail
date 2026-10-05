import type { BaseMcpConsoleResultV1 } from './baseMcpConsole.js';
import type { BaseMcpPluginSessionStoreV1 } from './baseMcpPluginSessionStore.js';
import type { callVirtualsReviewedV1 } from './virtualsReviewedClient.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{3,15}$/;
const forbidden = /\b(?:send|forward|reply|compose|create|delete|approve|buy|swap|transfer|pay|use|submit)\b|(?:^|\s)(?:отправ|перешли|ответь|созда|удал|одобр|использ|введи)\p{L}*/iu;

export function isVirtualsOtpReadV1(message: string): boolean {
  return /\botp\b|одноразов\p{L}*\s+код|verification\s+code/iu.test(message) && !forbidden.test(message);
}

function inputs(message: string, wallet: string): { agentId: string; messageId: string; reveal: boolean } | null {
  if (!isVirtualsOtpReadV1(message) || !/^0x[a-fA-F0-9]{40}$/.test(wallet) ||
      [...message.matchAll(/0x[a-fA-F0-9]{40}/gu)].some(m => m[0].toLowerCase() !== wallet.toLowerCase())) return null;
  const ids = (pattern: RegExp) => [...message.matchAll(pattern)].map(m => m[1]);
  const agents = ids(/(?:\bagent(?:\s*id)?|агент(?:а)?(?:\s*id)?)\s*[:=]?\s+([^\s,;]+)/giu);
  const messages = ids(/(?:\bmessage(?:\s*id)?|письм(?:о|а)(?:\s*id)?)\s*[:=]?\s+([^\s,;]+)/giu);
  if (agents.length !== 1 || messages.length !== 1 || !ID.test(agents[0]) || !ID.test(messages[0])) return null;
  const reveal = !/\bstatus\b|статус/iu.test(message) &&
    /\b(?:show|extract|get|read)\b|(?:^|\s)(?:покажи|извлеки|дай|прочитай)(?!\p{L})/iu.test(message);
  return { agentId: agents[0], messageId: messages[0], reveal };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A complete authenticated agent list is the ownership check; names are not identifiers. */
function ownsAgent(payload: unknown, agentId: string, wallet: string): boolean {
  const root = record(payload);
  if (root?.partial === true || root?.truncated === true || root?.complete === false ||
      root?.hasMore === true || root?.nextCursor || root?.success === false || root?.error) return false;
  const rows = Array.isArray(payload) ? payload : root?.agents;
  if (!Array.isArray(rows) || rows.length > 500 || (root?.count !== undefined && root.count !== rows.length)) return false;
  const ids = rows.map(row => {
    const item = record(row);
    if (!item || (item.walletAddress !== undefined && String(item.walletAddress).toLowerCase() !== wallet.toLowerCase())) return null;
    const id = item.agentId ?? item.id;
    return typeof id === 'string' && ID.test(id) ? id : null;
  });
  return ids.every(id => id !== null) && new Set(ids).size === ids.length && ids.includes(agentId);
}

/** Only bounded candidate-code fields are interpreted. Email text and links are never rendered. */
export function virtualsOtpCandidatesV1(payload: unknown, agentId: string, messageId: string): string[] | null {
  const data = record(payload);
  if (!data || data.success === false || data.error || data.partial === true || data.truncated === true ||
      (data.agentId !== undefined && data.agentId !== agentId) ||
      (data.messageId !== undefined && data.messageId !== messageId)) return null;
  const values: unknown[] = [];
  let explicit = false;
  for (const key of ['otp', 'code'] as const) {
    if (Object.hasOwn(data, key)) { explicit = true; if (data[key] !== null) values.push(data[key]); }
  }
  if (Object.hasOwn(data, 'codes')) {
    if (!Array.isArray(data.codes) || data.codes.length > 5) return null;
    explicit = true; values.push(...data.codes);
  }
  if (!explicit || values.some(value => typeof value !== 'string' || !CODE.test(value))) return null;
  const codes = [...new Set(values as string[])];
  if (codes.length > 5) return null;
  if ((data.found === true && codes.length === 0) || (data.found === false && codes.length > 0)) return null;
  return codes;
}

export async function runVirtualsOtpReadV1(input: {
  message: string; walletAddress: string; userId?: string; sessionSecret?: string;
}, runtime: { sessions: BaseMcpPluginSessionStoreV1; callVirtuals: typeof callVirtualsReviewedV1; now: () => Date }): Promise<BaseMcpConsoleResultV1> {
  const startedAt = Date.now(), checkedAt = runtime.now().toISOString();
  const trace: BaseMcpConsoleResultV1['trace'] = [];
  const finish = (status: BaseMcpConsoleResultV1['status'], reply: string, errorCode: string | null): BaseMcpConsoleResultV1 => ({
    status, reply, errorCode, trace, checkedAt, toolsAvailable: 2, truncated: false, elapsedMs: Date.now() - startedAt,
  });
  const facts = inputs(input.message, input.walletAddress);
  if (!facts) return finish('needs_input',
    'Name an agent ID and message ID, for example “Check my Virtuals email OTP status for agent agent-123 message message-456”. To see the code, ask “Show Virtuals OTP code for agent agent-123 message message-456”.', 'virtuals_otp_facts_required');
  if (!input.userId || !input.sessionSecret) return finish('needs_input', 'Sign in to Miorail before reading private Virtuals email.', 'virtuals_sign_in_required');
  try {
    if (!await runtime.sessions.available()) return finish('failed', 'Virtuals sign-in storage is unavailable. The message was not read.', 'virtuals_storage_unavailable');
    const session = await runtime.sessions.load({ userId: input.userId, sessionSecret: input.sessionSecret });
    if (!session || session.stage !== 'authenticated' || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= runtime.now().getTime()) {
      return finish('needs_input', 'Ask “Sign in to Virtuals” and approve that sign-in in your wallet, then repeat this OTP request. No agent will be created by sign-in.', 'virtuals_sign_in_required');
    }
    if (session.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase()) {
      return finish('needs_input', 'Sign in to Virtuals with the same wallet you used for Miorail. The message was not read.', 'virtuals_wallet_mismatch');
    }
    const call = async (method: 'agent_list' | 'agent_email_extract_otp', args: Record<string, unknown>) => {
      const response = await runtime.callVirtuals({ method, args: { token: session.token, ...args } });
      trace.push({ tool: `virtuals_${method}`, args: JSON.stringify(args), ok: response.ok,
        result: response.ok ? '{"read":true,"privatePayload":"[redacted]"}' : '', errorCode: response.ok ? null : response.errorCode });
      if (!response.ok && response.errorCode === 'virtuals_session_expired') await runtime.sessions.clear(input.userId!);
      return response;
    };
    const agents = await call('agent_list', {});
    if (!agents.ok) return finish('failed', 'Virtuals could not verify your agent. Sign in again if your session expired, then retry.', agents.errorCode);
    if (!ownsAgent(agents.data, facts.agentId, input.walletAddress)) {
      trace[0].ok = false; trace[0].errorCode = 'virtuals_agent_unverified';
      return finish('needs_input', 'That agent was not established in your signed-in Virtuals account. Ask “List my Virtuals agents” and use an ID from that list. The message was not read.', 'virtuals_agent_unverified');
    }
    const response = await call('agent_email_extract_otp', { agentId: facts.agentId, messageId: facts.messageId });
    if (!response.ok) return finish('failed', 'Virtuals could not read the verification code from that message. A failed read does not mean there is no code.', response.errorCode);
    const codes = virtualsOtpCandidatesV1(response.data, facts.agentId, facts.messageId);
    if (!codes || codes.some(code => code === session.token || code === session.refreshToken)) {
      trace[1].ok = false; trace[1].errorCode = 'virtuals_otp_invalid_response';
      return finish('failed', 'Virtuals returned an OTP result Miorail could not read. Whether the message contains a code was not established.', 'virtuals_otp_invalid_response');
    }
    trace[1].result = JSON.stringify({ status: codes.length ? 'candidate_found' : 'not_found', candidates: codes.length });
    if (codes.length === 0) return finish('answered', 'Virtuals reports no candidate verification code in that message. The email body was not shown.', null);
    return finish('answered', facts.reveal
      ? `Virtuals candidate verification code${codes.length > 1 ? 's' : ''}: ${codes.join(', ')}. Validity and expiry were not checked. No code was submitted or used.`
      : `Virtuals found ${codes.length} candidate verification code${codes.length > 1 ? 's' : ''} in that message. The code is hidden; explicitly ask “Show Virtuals OTP code” with the same agent ID and message ID to see it. Validity and expiry were not checked.`, null);
  } catch {
    return finish('failed', 'The private Virtuals OTP read could not finish. Retry; the presence of a code was not established.', 'virtuals_otp_unavailable');
  }
}
