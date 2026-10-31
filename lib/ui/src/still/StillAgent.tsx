import React, { useEffect, useRef, useState } from 'react';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import {
  AGENT_PROMPTS_V1,
  agentAnswerV1,
  agentRouteV2,
  isRussianV1,
  type AgentAnswerV1,
  type AgentModeV2,
  type DividendReadStateV1,
} from './agentAnswers';
import type { SkyStateV1 } from './skyState';
import { StillGlyph, StillHeader, StillLink } from './StillFrame';

void React;

/** One stage of the server's work, as it streams it: what is being done, with what it found. */
export interface AgentStageV2 {
  stage: 'reading' | 'read' | 'understanding' | 'understood' | 'computing' | 'computed' | 'wording' | 'checked';
  block?: string;
  blockTime?: string;
  summary?: string;
  by?: 'rules' | 'model';
  figures?: number;
  verified?: boolean;
}

/** Which of the three orbs a stage belongs to: the wallet, the engine, the words. */
function phaseOfV2(stage: AgentStageV2['stage']): 'evidence' | 'risk' | 'llm' {
  if (stage === 'reading' || stage === 'read') return 'evidence';
  if (stage === 'wording' || stage === 'checked') return 'llm';
  return 'risk';
}

export function stageLabelV2(event: AgentStageV2, ru: boolean): string {
  const block = event.block ? Number(event.block).toLocaleString('en-US') : '';
  switch (event.stage) {
    case 'reading':
      return ru ? 'Читаю ваш кошелёк на Base…' : 'Reading your wallet on Base…';
    case 'read':
      return ru ? `Прочитано на блоке ${block}` : `Read at block ${block}`;
    case 'understanding':
      return ru ? 'Разбираю вопрос…' : 'Reading the question…';
    case 'understood':
      return ru ? `Понял: ${event.summary}` : `Understood: ${event.summary}`;
    case 'computing':
      return ru ? `Движок Still считает: ${event.summary}…` : `Still engine computing: ${event.summary}…`;
    case 'computed':
      return ru ? `Посчитано, чисел: ${event.figures}` : `Computed: ${event.figures} figures`;
    case 'wording':
      return ru ? 'Пересказываю; каждое число будет сверено…' : 'Wording the answer; every figure will be checked…';
    case 'checked':
      return event.verified
        ? ru ? 'Пересказ сверен с расчётом' : 'Wording checked against the calculation'
        : ru ? 'Пересказ не прошёл проверку: показываю расчёт' : 'Wording failed the check: showing the calculation';
  }
}

export function ThinkingOrbs({ event, russian = false }: { event: AgentStageV2; russian?: boolean }) {
  return (
    <div role="status" className="still-thinking-orbs" data-phase={phaseOfV2(event.stage)}>
      <span className="still-orbs-cluster" aria-hidden="true">
        <span className="still-orb orb-evidence" />
        <span className="still-orb orb-risk" />
        <span className="still-orb orb-llm" />
      </span>
      <span className="still-thinking-label">{stageLabelV2(event, russian)}</span>
    </div>
  );
}

function modeBadgeLabelV2(mode: AgentModeV2 | undefined, ru: boolean): string | null {
  if (mode === 'fast') return ru ? 'Прямое чтение' : 'Direct read';
  if (mode === 'analysis') return ru ? 'Расчёт · движок Still' : 'Calculated · Still engine';
  if (mode === 'action_prep') return ru ? 'Подготовка · подпись в кошельке' : 'Action prep · wallet confirmation';
  if (mode === 'refused') return ru ? 'Не посчитано' : 'Not computed';
  return null;
}

/** What the trace says about how the answer was made, in the order it happened. */
function traceLineV2(trace: readonly AgentStageV2[], ru: boolean): string | null {
  const parts: string[] = [];
  const understood = trace.find((e) => e.stage === 'understood');
  if (understood) parts.push(understood.by === 'model' ? (ru ? 'вопрос прочитан моделью и сверен с вашими словами' : 'question read by a model, checked against your words') : (ru ? 'вопрос прочитан правилами' : 'question read by fixed rules'));
  if (trace.some((e) => e.stage === 'computed')) parts.push(ru ? 'посчитано движком Still' : 'computed by the Still engine');
  const checked = trace.find((e) => e.stage === 'checked');
  if (checked) parts.push(checked.verified ? (ru ? 'пересказ сверен' : 'wording checked') : (ru ? 'пересказ отклонён' : 'wording rejected'));
  return parts.length ? parts.join(' · ') : null;
}

function readingAgeV2(answer: AgentAnswerV1, receivedAt: number, ru: boolean): string | null {
  if (!answer.calculatedAt) return null;
  const block = Number(answer.calculatedAt.block).toLocaleString('en-US');
  const seconds = Math.max(0, Math.round((receivedAt - Date.parse(answer.calculatedAt.blockTime)) / 1000));
  const age = seconds < 120 ? `${seconds} ${ru ? 'с' : 's'}` : `${Math.round(seconds / 60)} ${ru ? 'мин' : 'min'}`;
  return ru ? `Блок Base ${block}, прочитан за ${age} до ответа` : `Base block ${block}, read ${age} before this answer`;
}

export interface StillAgentModelV1 {
  sky: SkyStateV1;
  report: MirrorReport | null;
  dividends: DividendWalletResponseV1 | null;
  dividendsReadState?: DividendReadStateV1;
  /** True while the wallet is being read; questions wait for it. */
  reading: boolean;
  signedIn: boolean;
  /** Authoritative signed-in session wallet, not the browser connector or a
   * report that may still be arriving from the previous session. */
  walletIdentity?: string | null;
  /** Explicit presentation language. The web uses English; each answer follows its question. */
  russian: boolean;
}

interface TurnV1 {
  id: number;
  question: string;
  /** Null while the server works. */
  answer: AgentAnswerV1 | null;
  stage: AgentStageV2 | null;
  trace: AgentStageV2[];
  receivedAt: number;
}

/**
 * Asks the server and follows its stages. The body is one JSON object per line;
 * a browser without a streaming body reads them all at the end.
 */
async function askServerV2(question: string, onStage: (event: AgentStageV2) => void): Promise<AgentAnswerV1 | 'signed_out' | 'rate_limited' | null> {
  const res = await window.fetch('/api/still/agent/ask', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ question }),
  });
  // Said in words the person can act on: neither is a failure of the calculation.
  if (res.status === 401) return 'signed_out';
  if (res.status === 429) return 'rate_limited';
  if (!res.ok) return null;
  let answer: AgentAnswerV1 | null = null;
  const take = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type?: string; answer?: AgentAnswerV1 } & AgentStageV2;
    if (event.type === 'stage') onStage(event);
    else if (event.type === 'answer' && event.answer) answer = event.answer;
  };
  if (!res.body || typeof res.body.getReader !== 'function') {
    (await res.text()).split('\n').forEach(take);
    return answer;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    lines.forEach(take);
    if (done) break;
  }
  take(buffered);
  return answer;
}

export function StillAgent({ model }: { model: StillAgentModelV1 }) {
  // A key changes the state owner during render, before a new wallet could
  // paint an old answer or draft. A normal report refresh keeps the same key.
  const wallet = model.walletIdentity === undefined ? model.report?.subject.address ?? null : model.walletIdentity;
  const owner = model.signedIn ? wallet?.toLowerCase() ?? null : null;
  const ownsReport = owner !== null && model.report?.subject.address.toLowerCase() === owner;
  const safeModel = { ...model, report: ownsReport ? model.report : null,
    dividends: ownsReport ? model.dividends : null,
    dividendsReadState: ownsReport ? model.dividendsReadState : 'not_loaded' as const };
  return <StillAgentSession key={owner ?? 'signed-out'} model={safeModel} />;
}

function StillAgentSession({ model }: { model: StillAgentModelV1 }) {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<TurnV1[]>([]);
  const nextTurnId = useRef(1);
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On a desktop the conversation scrolls inside its workspace. A reply
    // to the person's new question must not remain below older answers.
    if (chat.current) chat.current.scrollTo({ top: chat.current.scrollHeight });
  }, [turns.length]);
  const update = (id: number, change: (turn: TurnV1) => TurnV1) => setTurns((previous) => previous.map((turn) => (turn.id === id ? change(turn) : turn)));
  const ask = (question: string) => {
    const text = question.trim();
    if (!text) return;
    const { route } = agentRouteV2(text);
    const local = () => agentAnswerV1({
      question: text,
      report: model.report,
      sky: model.sky,
      dividends: model.dividends,
      dividendsReadState: model.dividendsReadState,
      signedIn: model.signedIn,
    });
    const id = nextTurnId.current++;
    setDraft('');
    // A calculation, and any question the page's rules do not know, are the
    // server's: it reads the wallet itself and computes with the Mirror engine.
    const remote = (route === 'analysis' || route === 'unknown') && model.signedIn && model.report !== null && typeof window !== 'undefined' && typeof window.fetch === 'function';
    if (!remote) {
      setTurns((previous) => [...previous, { id, question: text, answer: local(), stage: null, trace: [], receivedAt: Date.now() }]);
      return;
    }
    setTurns((previous) => [...previous, { id, question: text, answer: null, stage: { stage: 'reading' }, trace: [], receivedAt: 0 }]);
    const ru = isRussianV1(text);
    const said = (words: string): AgentAnswerV1 => ({ topic: null, mode: 'refused', text: words, sources: [] });
    void askServerV2(text, (event) => update(id, (turn) => ({ ...turn, stage: event, trace: [...turn.trace, event] })))
      .then((result) => {
        const answer =
          result === 'signed_out'
            ? said(ru ? 'Сессия закончилась: войдите снова, и я прочитаю ваш кошелёк.' : 'Your session ended: sign in again and I will read your wallet.')
            : result === 'rate_limited'
              ? said(ru ? 'Слишком много вопросов за минуту. Спросите снова через минуту.' : 'Too many questions this minute. Ask again in a minute.')
              : result ?? local();
        update(id, (turn) => ({ ...turn, answer, stage: null, receivedAt: Date.now() }));
      })
      .catch(() => update(id, (turn) => ({ ...turn, answer: local(), stage: null, receivedAt: Date.now() })));
  };
  const busy = turns.some((turn) => turn.answer === null);
  return (
    <div className="still-agent-page">
      <StillHeader title="Agent" sky={model.sky} />
      <p className="still-section still-note" style={{ marginTop: 4 }}>
        {model.russian ? 'Читает ваш кошелёк и считает движком Still. Никогда не подписывает.' : 'Reads your wallet and computes with Still’s engine. Never signs.'}
      </p>
      <div className="still-agent-workspace">
      <div ref={chat} className={`still-agent-chat${turns.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
        {turns.length === 0 ? (
          <p className="still-note">{model.russian ? 'Спросите о своих деньгах.' : 'Ask about your money.'}</p>
        ) : null}
        {turns.map((turn) => {
          const ru = isRussianV1(turn.question);
          const answer = turn.answer;
          const badge = answer ? modeBadgeLabelV2(answer.mode, ru) : null;
          const trace = answer ? traceLineV2(turn.trace, ru) : null;
          const age = answer ? readingAgeV2(answer, turn.receivedAt, ru) : null;
          return (
            <div key={turn.id} style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div className="still-bubble-me">{turn.question}</div>
              </div>
              <div className="still-card still-bubble" style={{ marginTop: 10 }}>
                <div className="still-agent-bubble-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <StillGlyph size={0.8} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Still</span>
                  </div>
                  {badge ? (
                    <span className="still-agent-mode-badge mono" data-mode={answer!.mode}>
                      {badge}
                    </span>
                  ) : null}
                </div>
                {!answer && turn.stage ? (
                  <div style={{ marginTop: 8 }}>
                    <ThinkingOrbs event={turn.stage} russian={ru} />
                  </div>
                ) : null}
                {answer ? (
                  <>
                    <div style={{ fontSize: 15, lineHeight: 1.45, marginTop: 6 }}>{answer.text}</div>
                    {answer.steps && answer.steps.length > 0 ? (
                      <ul className="still-agent-steps">
                        {answer.steps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    ) : null}
                    {answer.bounds && answer.bounds.length > 0 ? (
                      <div className="still-agent-bounds">
                        <div className="still-eyebrow">{ru ? 'Что держится неизменным' : 'What this holds fixed'}</div>
                        <ul>
                          {answer.bounds.map((bound) => (
                            <li key={bound}>{bound}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {answer.actionLink ? (
                      <div className="still-agent-action" style={{ marginTop: 10 }}>
                        <StillLink href={answer.actionLink.href} className="still-btn sec">
                          {answer.actionLink.label}
                        </StillLink>
                      </div>
                    ) : null}
                    {answer.sources.length > 0 || age || trace ? (
                      <div className="mono still-clock" style={{ marginTop: 8, lineHeight: 1.5 }}>
                        {answer.sources.map((source) => <div key={source}>{source}</div>)}
                        {age ? <div>{age}</div> : null}
                        {trace ? <div>{trace}</div> : null}
                      </div>
                    ) : null}
                    {answer.topic === null && !answer.mode ? (
                      <p className="still-note" style={{ marginTop: 8 }}>
                        {ru ? 'Для обмена токенов есть ' : 'For swapping tokens there is '}
                        <StillLink href="/routes">Swap AI</StillLink>.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {model.reading && model.signedIn ? (
          <div style={{ marginTop: 12 }}>
            <ThinkingOrbs event={{ stage: 'reading' }} russian={model.russian} />
          </div>
        ) : null}
      </div>
      <div className="still-agent-suggestions">
        <div className="still-eyebrow">{model.russian ? 'Вопросы для начала' : 'Start with a question'}</div>
        {AGENT_PROMPTS_V1.map((prompt) => {
          const text = model.russian ? prompt.ru : prompt.en;
          return (
            <button key={prompt.en} type="button" className="still-chip" onClick={() => ask(text)} disabled={(model.reading && model.signedIn) || busy}>
              {text}
            </button>
          );
        })}
      </div>
      <form
        className="still-agent-composer still-field"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) ask(draft);
        }}
      >
        <label className="visually-hidden" htmlFor="still-ask">{model.russian ? 'Вопрос о ваших деньгах' : 'A question about your money'}</label>
        <input
          id="still-ask"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={model.russian ? 'Спросите о своих деньгах' : 'Ask about your money'}
          autoComplete="off"
        />
        <button type="submit" className="still-btn" aria-label={model.russian ? 'Спросить' : 'Ask'} disabled={!draft.trim() || busy}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
      </div>
    </div>
  );
}
