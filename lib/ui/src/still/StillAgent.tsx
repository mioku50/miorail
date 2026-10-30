import React, { useEffect, useRef, useState } from 'react';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';

import {
  AGENT_PROMPTS_V1,
  agentAnswerV1,
  isRussianV1,
  type AgentAnswerV1,
  type AgentModeV2,
  type DividendReadStateV1,
} from './agentAnswers';
import type { SkyStateV1 } from './skyState';
import { StillGlyph, StillHeader, StillLink } from './StillFrame';

void React;

export type ThinkingStageV2 = 'evidence' | 'risk_engine' | 'synthesis';

export function ThinkingOrbs({
  stage = 'risk_engine',
  russian = false,
}: {
  stage?: ThinkingStageV2;
  russian?: boolean;
}) {
  const label =
    stage === 'evidence'
      ? russian
        ? 'Читаю доказательства кошелька на Base…'
        : 'Reading wallet evidence on Base…'
      : stage === 'risk_engine'
        ? russian
          ? 'Риск-движок считает сценарий и пороги ликвидации…'
          : 'Risk Engine computing scenario and liquidation thresholds…'
        : russian
          ? 'Проверяю объяснение по расчёту риск-движка…'
          : 'Verifying explanation against Risk Engine math…';

  return (
    <div role="status" className="still-thinking-orbs" data-stage={stage}>
      <span className="still-orbs-cluster" aria-hidden="true">
        <span className="still-orb orb-evidence" />
        <span className="still-orb orb-risk" />
        <span className="still-orb orb-llm" />
      </span>
      <span className="still-thinking-label">{label}</span>
    </div>
  );
}

function modeBadgeLabelV2(mode: AgentModeV2 | undefined, ru: boolean): string | null {
  if (mode === 'fast') return ru ? 'Прямое чтение' : 'Direct read';
  if (mode === 'analysis') return ru ? 'Расчёт · по этому чтению' : 'Calculated · from this reading';
  if (mode === 'action_prep') return ru ? 'Подготовка · Подпись в кошельке' : 'Action prep · Wallet confirmation';
  if (mode === 'refused') return ru ? 'Отказ · Недостаточно данных' : 'Refused · Missing evidence';
  return null;
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
  answer: AgentAnswerV1;
  thinkingStage?: ThinkingStageV2 | null;
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
  const ask = (question: string) => {
    const text = question.trim();
    if (!text) return;
    const baseAnswer = agentAnswerV1({
      question: text,
      report: model.report,
      sky: model.sky,
      dividends: model.dividends,
      dividendsReadState: model.dividendsReadState,
      signedIn: model.signedIn,
    });
    const turnId = nextTurnId.current++;
    const canEnrichWithLlm =
      Boolean(baseAnswer.needsLlm) &&
      model.signedIn &&
      model.report !== null &&
      typeof window !== 'undefined' &&
      typeof window.fetch === 'function';

    setTurns((previous) => [
      ...previous,
      {
        id: turnId,
        question: text,
        answer: baseAnswer,
        thinkingStage: canEnrichWithLlm ? 'synthesis' : null,
      },
    ]);
    setDraft('');

    if (canEnrichWithLlm && model.report) {
      void window
        .fetch('/api/still/agent/ask', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: text }),
        })
        .then(async (res) => {
          if (!res.ok) return null;
          const payload = (await res.json()) as { ok?: boolean; answer?: AgentAnswerV1 };
          return payload?.ok && payload.answer ? payload.answer : null;
        })
        .then((enriched) => {
          setTurns((previous) =>
            previous.map((item) =>
              item.id === turnId
                ? {
                    ...item,
                    answer: enriched ?? item.answer,
                    thinkingStage: null,
                  }
                : item,
            ),
          );
        })
        .catch(() => {
          setTurns((previous) =>
            previous.map((item) => (item.id === turnId ? { ...item, thinkingStage: null } : item)),
          );
        });
    }
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
        {turns.map((turn) => {
          const ru = isRussianV1(turn.question);
          const badge = modeBadgeLabelV2(turn.answer.mode, ru);
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
                    <span className="still-agent-mode-badge mono" data-mode={turn.answer.mode}>
                      {badge}
                    </span>
                  ) : null}
                </div>
                {turn.thinkingStage ? (
                  <div style={{ marginTop: 8 }}>
                    <ThinkingOrbs stage={turn.thinkingStage} russian={ru} />
                  </div>
                ) : null}
                <div style={{ fontSize: 15, lineHeight: 1.45, marginTop: 6 }}>{turn.answer.text}</div>
                {turn.answer.steps && turn.answer.steps.length > 0 ? (
                  <ul className="still-agent-steps">
                    {turn.answer.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                ) : null}
                {turn.answer.actionLink ? (
                  <div className="still-agent-action" style={{ marginTop: 10 }}>
                    <StillLink href={turn.answer.actionLink.href} className="still-btn sec">
                      {turn.answer.actionLink.label}
                    </StillLink>
                  </div>
                ) : null}
                {turn.answer.sources.length > 0 ? (
                  <div className="mono still-clock" style={{ marginTop: 8, lineHeight: 1.5 }}>
                    {turn.answer.sources.map((source) => <div key={source}>{source}</div>)}
                  </div>
                ) : null}
                {turn.answer.topic === null ? (
                  <p className="still-note" style={{ marginTop: 8 }}>
                    {ru ? 'Для обмена токенов есть ' : 'For swapping tokens there is '}
                    <StillLink href="/routes">Swap AI</StillLink>.
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
        {model.reading && model.signedIn ? (
          <div style={{ marginTop: 12 }}>
            <ThinkingOrbs stage="evidence" russian={model.russian} />
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
