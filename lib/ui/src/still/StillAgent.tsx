import React, { useEffect, useRef, useState } from 'react';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import { AGENT_PROMPTS_V1, agentAnswerV1, isRussianV1, type AgentAnswerV1, type DividendReadStateV1 } from './agentAnswers';
import type { SkyStateV1 } from './skyState';
import { StillGlyph, StillHeader, StillLink } from './StillFrame';

void React;

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
  question: string;
  answer: AgentAnswerV1;
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
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On a desktop the conversation scrolls inside its workspace. A reply
    // to the person's new question must not remain below older answers.
    if (chat.current) chat.current.scrollTo({ top: chat.current.scrollHeight });
  }, [turns.length]);
  const ask = (question: string) => {
    const text = question.trim();
    if (!text) return;
    setTurns((previous) => [...previous, { question: text, answer: agentAnswerV1({ question: text, report: model.report, sky: model.sky, dividends: model.dividends, dividendsReadState: model.dividendsReadState, signedIn: model.signedIn }) }]);
    setDraft('');
  };
  return (
    <div className="still-agent-page">
      <StillHeader title="Agent" sky={model.sky} />
      <p className="still-section still-note" style={{ marginTop: 4 }}>
        {model.russian ? 'Читает ваш кошелёк и числа Still. Никогда не подписывает.' : 'Reads your wallet and Still’s numbers. Never signs.'}
      </p>
      <div className="still-agent-workspace">
      <div ref={chat} className={`still-agent-chat${turns.length === 0 ? ' is-empty' : ''}`} aria-live="polite">
        {turns.length === 0 ? (
          <p className="still-note">{model.russian ? 'Спросите о своих деньгах.' : 'Ask about your money.'}</p>
        ) : null}
        {turns.map((turn, index) => (
          <div key={index} style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div className="still-bubble-me">{turn.question}</div>
            </div>
            <div className="still-card still-bubble" style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StillGlyph size={0.8} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Still</span>
              </div>
              <div style={{ fontSize: 15, lineHeight: 1.45, marginTop: 6 }}>{turn.answer.text}</div>
              {turn.answer.sources.length > 0 ? (
                <div className="mono still-clock" style={{ marginTop: 8, lineHeight: 1.5 }}>
                  {turn.answer.sources.map((source) => <div key={source}>{source}</div>)}
                </div>
              ) : null}
              {turn.answer.topic === null ? (
                <p className="still-note" style={{ marginTop: 8 }}>
                  {isRussianV1(turn.question) ? 'Для обмена токенов есть ' : 'For swapping tokens there is '}
                  <StillLink href="/routes">Swap AI</StillLink>.
                </p>
              ) : null}
            </div>
          </div>
        ))}
        {model.reading && model.signedIn ? (
          <div role="status" className="still-note" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <span className="still-thinking"><StillGlyph size={0.9} /></span>
            {model.russian ? 'Читаю ваш кошелёк на Base…' : 'Reading your wallet on Base…'}
          </div>
        ) : null}
      </div>
      <div className="still-agent-suggestions">
        <div className="still-eyebrow">{model.russian ? 'Вопросы для начала' : 'Start with a question'}</div>
        {AGENT_PROMPTS_V1.map((prompt) => {
          const text = model.russian ? prompt.ru : prompt.en;
          return (
            <button key={prompt.en} type="button" className="still-chip" onClick={() => ask(text)} disabled={model.reading && model.signedIn}>
              {text}
            </button>
          );
        })}
      </div>
      <form
        className="still-agent-composer still-field"
        onSubmit={(event) => {
          event.preventDefault();
          ask(draft);
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
        <button type="submit" className="still-btn" aria-label={model.russian ? 'Спросить' : 'Ask'} disabled={!draft.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
      </div>
    </div>
  );
}
