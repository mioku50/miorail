import React from 'react';
import {
  radarGeometryV1,
  CONSOLE_COPY_V1,
  type ConsoleStepViewV1,
  type ScoreDimensionViewV1,
} from './consoleState';

void React;

// ---------------------------------------------------------------------------
// Console graphics. Every fill/stroke comes from a class hook in console.css,
// so a chart re-themes with the rest of the app and no colour is hardcoded
// here. Each chart carries role="img" + an aria-label that states the DATA in
// words — colour is never the only carrier of meaning.
// ---------------------------------------------------------------------------

export function ConsoleStepper({ steps }: { steps: readonly ConsoleStepViewV1[] }) {
  return (
    <div className="stepper" role="list" aria-label="Route progress">
      {steps.map((step) => (
        <div
          key={step.name}
          role="listitem"
          className={`st ${step.state === 'done' ? 'done' : step.state === 'now' ? 'now' : ''}`}
          aria-current={step.state === 'now' ? 'step' : undefined}
        >
          <div className="n">{step.name}</div>
          <div className="b" />
          <div className="tm">{step.timing}</div>
        </div>
      ))}
    </div>
  );
}

/** Compact rail for the miniapp — "Step 5 of 8 · Score", expandable on tap. */
export function ConsoleStepperCompact({
  label,
  steps,
  expanded,
  onToggle,
}: {
  label: string;
  steps: readonly ConsoleStepViewV1[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="ph"
        style={{ width: '100%', background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', borderBottom: expanded ? undefined : '0' }}
      >
        <h3>{label}</h3>
        <span className="rt">
          <span className="pill n">{expanded ? 'hide' : 'show all'}</span>
        </span>
      </button>
      {expanded && (
        <div className="pb tight">
          <ul className="lsteps">
            {steps.map((step) => (
              <li key={step.name} className={step.state === 'todo' ? 'pending' : undefined}>
                <span className="mk">
                  {step.state === 'done' ? <span className="ok">✓</span> : step.state === 'now' ? <span className="spin" /> : <span className="pend" />}
                </span>
                <span className="lb">{step.name}</span>
                <span className="vl mono">{step.timing}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface RouteGraphNodeV1 {
  id: string;
  title: string;
  subtitle: string;
  kind: 'input' | 'pool-a' | 'pool-b' | 'output';
}

export interface RouteGraphModelV1 {
  input: RouteGraphNodeV1;
  pools: RouteGraphNodeV1[];
  output: RouteGraphNodeV1;
  /** Spoken description for screen readers — required, not decorative. */
  description: string;
}

const NODE_CLASS_V1: Record<RouteGraphNodeV1['kind'], string> = {
  input: 'n-neutral',
  'pool-a': 'n-a',
  'pool-b': 'n-b',
  output: 'n-o',
};

/**
 * The route graph. Horizontal on desktop, vertical on the miniapp (input top,
 * pools middle, output bottom) — it is the product's core idea, so it survives
 * every breakpoint rather than being dropped.
 */
export function RouteGraph({ model, orientation = 'horizontal' }: { model: RouteGraphModelV1; orientation?: 'horizontal' | 'vertical' }) {
  const pools = model.pools.slice(0, 2);
  if (orientation === 'vertical') {
    const rowY = (index: number) => 120 + index * 74;
    return (
      <svg className="graph tall" viewBox="0 0 340 320" preserveAspectRatio="xMidYMid meet" role="img" aria-label={model.description}>
        <defs>
          <linearGradient id="mio-gl-v" x1="0" y1="0" x2="0" y2="1">
            <stop className="sc-b" offset="0%" />
            <stop className="sc-v" offset="100%" />
          </linearGradient>
        </defs>
        {pools.map((pool, index) => (
          <g key={`edge-${pool.id}`}>
            <path d={`M170,66 C170,96 170,96 170,${rowY(index)}`} stroke="url(#mio-gl-v)" strokeWidth={index === 0 ? 6 : 4} fill="none" opacity={index === 0 ? 0.85 : 0.55} />
            <path d={`M170,${rowY(index) + 46} C170,${rowY(index) + 70} 170,${rowY(index) + 70} 170,254`} stroke="url(#mio-gl-v)" strokeWidth={index === 0 ? 6 : 4} fill="none" opacity={index === 0 ? 0.85 : 0.55} />
          </g>
        ))}
        <rect className={NODE_CLASS_V1[model.input.kind]} x="60" y="20" width="220" height="46" rx="11" />
        <text className="svg-t" x="76" y="40" fontSize="14" fontWeight="600" fontFamily="system-ui">{model.input.title}</text>
        <text className="svg-d" x="76" y="56" fontSize="11" fontFamily="system-ui">{model.input.subtitle}</text>
        {pools.map((pool, index) => (
          <g key={pool.id}>
            <rect className={NODE_CLASS_V1[pool.kind]} x="30" y={rowY(index)} width="280" height="46" rx="11" />
            <text className="svg-t" x="46" y={rowY(index) + 20} fontSize="13" fontWeight="600" fontFamily="system-ui">{pool.title}</text>
            <text className="svg-s" x="46" y={rowY(index) + 36} fontSize="11" fontFamily="system-ui">{pool.subtitle}</text>
          </g>
        ))}
        <rect className={NODE_CLASS_V1[model.output.kind]} x="60" y="254" width="220" height="46" rx="11" />
        <text className="svg-t" x="76" y="274" fontSize="14" fontWeight="600" fontFamily="system-ui">{model.output.title}</text>
        <text className="svg-d" x="76" y="290" fontSize="11" fontFamily="system-ui">{model.output.subtitle}</text>
      </svg>
    );
  }

  const poolY = (index: number) => (pools.length === 1 ? 52 : index === 0 ? 19 : 89);
  return (
    <svg className="graph" viewBox="0 0 900 150" preserveAspectRatio="xMidYMid meet" role="img" aria-label={model.description}>
      <defs>
        <linearGradient id="mio-gl" x1="0" y1="0" x2="1" y2="0">
          <stop className="sc-b" offset="0%" />
          <stop className="sc-v" offset="100%" />
        </linearGradient>
      </defs>
      {pools.map((pool, index) => {
        const y = poolY(index) + 23;
        const weight = index === 0 ? 7 : 4;
        const opacity = index === 0 ? 0.85 : 0.55;
        return (
          <g key={`edge-${pool.id}`}>
            <path d={`M150,75 C230,75 240,${y} 320,${y}`} stroke="url(#mio-gl)" strokeWidth={weight} fill="none" opacity={opacity} />
            <path d={`M560,${y} C640,${y} 650,75 730,75`} stroke="url(#mio-gl)" strokeWidth={weight} fill="none" opacity={opacity} />
          </g>
        );
      })}
      <rect className={NODE_CLASS_V1[model.input.kind]} x="20" y="52" width="130" height="46" rx="11" />
      <text className="svg-t" x="36" y="72" fontSize="14" fontWeight="600" fontFamily="system-ui">{model.input.title}</text>
      <text className="svg-d" x="36" y="88" fontSize="11" fontFamily="system-ui">{model.input.subtitle}</text>
      {pools.map((pool, index) => (
        <g key={pool.id}>
          <rect className={NODE_CLASS_V1[pool.kind]} x="320" y={poolY(index)} width="240" height="46" rx="11" />
          <text className="svg-t" x="336" y={poolY(index) + 20} fontSize="13" fontWeight="600" fontFamily="system-ui">{pool.title}</text>
          <text className="svg-s" x="336" y={poolY(index) + 36} fontSize="11" fontFamily="system-ui">{pool.subtitle}</text>
        </g>
      ))}
      <rect className={NODE_CLASS_V1[model.output.kind]} x="730" y="52" width="150" height="46" rx="11" />
      <text className="svg-t" x="746" y="72" fontSize="14" fontWeight="600" fontFamily="system-ui">{model.output.title}</text>
      <text className="svg-d" x="746" y="88" fontSize="11" fontFamily="system-ui">{model.output.subtitle}</text>
    </svg>
  );
}

/** Radar. An unscored dimension is a DASHED axis to the centre and an open
 * point — never a filled vertex at zero, which would read as "scored badly". */
export function ScoreRadar({ rows, label }: { rows: readonly ScoreDimensionViewV1[]; label: string }) {
  const geometry = radarGeometryV1(rows);
  return (
    <svg viewBox="0 0 120 132" width="180" height="198" role="img" aria-label={label}>
      <defs>
        <linearGradient id="mio-rg" x1="0" y1="0" x2="1" y2="1">
          <stop className="sc-b" offset="0%" stopOpacity=".55" />
          <stop className="sc-v" offset="100%" stopOpacity=".45" />
        </linearGradient>
      </defs>
      {geometry.gridRings.map((ring, index) => (
        <polygon key={ring} className="grid-l" opacity={index === 0 ? 1 : index === 1 ? 0.6 : 0.4} points={ring} fill="none" />
      ))}
      {geometry.unscoredAxes.map((axis) => (
        <line key={`${axis.x2}-${axis.y2}`} className="grid-l" x1={axis.x1} y1={axis.y1} x2={axis.x2} y2={axis.y2} strokeDasharray="3 3" />
      ))}
      <polygon className="ln-b" points={geometry.shape} fill="url(#mio-rg)" strokeWidth="1.4" />
      {geometry.points.map((point) =>
        point.scored ? (
          <circle key={`${point.x}-${point.y}`} className="pt" cx={point.x} cy={point.y} r="2.4" />
        ) : (
          <circle key={`${point.x}-${point.y}`} className="pt-o" cx={point.x} cy={point.y} r="2.4" strokeDasharray="2 2" />
        ),
      )}
      {geometry.labels.map((entry) => (
        <text
          key={entry.text}
          className={entry.scored ? 'svg-s' : 'svg-d'}
          x={entry.x}
          y={entry.y}
          textAnchor="middle"
          fontSize="7"
          fontFamily="system-ui"
        >
          {entry.text}
        </text>
      ))}
      {geometry.unscoredAxes.length > 0 && (
        <text className="svg-d" x="60" y="127" textAnchor="middle" fontSize="7" fontFamily="system-ui">
          {CONSOLE_COPY_V1.dashedAxis}
        </text>
      )}
    </svg>
  );
}

/** Score rows. A not-scored dimension gets a hatched track and the words. */
export function ScoreRows({ rows }: { rows: readonly ScoreDimensionViewV1[] }) {
  return (
    <div>
      {rows.map((row) => (
        <div key={row.key} className={`scorerow${row.scored ? '' : ' na'}`}>
          <span className="nm">{row.label}</span>
          {row.scored ? (
            <span className="track">
              <span style={{ width: `${row.width}%` }} />
            </span>
          ) : (
            <span className="track na" />
          )}
          <span className="nu">{row.numberLabel}</span>
          <span className="cf">{row.confidenceLabel}</span>
        </div>
      ))}
    </div>
  );
}

export function Sparkline({ points, label, height = 40, gradientId }: { points: readonly number[]; label: string; height?: number; gradientId: string }) {
  if (points.length < 2) {
    return <div className="empty">{label}</div>;
  }
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 34 - ((value - min) / span) * 28 - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="spark" style={{ height }} viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop className="sc-b" offset="0%" stopOpacity=".40" />
          <stop className="sc-b" offset="100%" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M${coords.join(' L')} L100,34 L0,34 Z`} fill={`url(#${gradientId})`} />
      <polyline className="ln-b" points={coords.join(' ')} fill="none" strokeWidth="1.6" />
    </svg>
  );
}

export function DepthCurve({ markerPercent, label }: { markerPercent: number; label: string }) {
  const x = Math.max(0, Math.min(100, markerPercent));
  return (
    <svg className="spark" style={{ height: 56 }} viewBox="0 0 100 46" preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id="mio-dg" x1="0" y1="0" x2="0" y2="1">
          <stop className="sc-v" offset="0%" stopOpacity=".35" />
          <stop className="sc-v" offset="100%" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0,40 C22,36 38,26 54,18 C70,10 84,6 100,3 L100,46 L0,46 Z" fill="url(#mio-dg)" />
      <path className="ln-v" d="M0,40 C22,36 38,26 54,18 C70,10 84,6 100,3" fill="none" strokeWidth="1.6" />
      <line className="grid-l" x1={x} y1="0" x2={x} y2="46" strokeDasharray="3 3" />
    </svg>
  );
}

export function BudgetDonut({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * 26;
  const filled = (clamped / 100) * circumference;
  return (
    <svg width="66" height="66" viewBox="0 0 66 66" role="img" aria-label={label}>
      <circle className="donut-bg" cx="33" cy="33" r="26" fill="none" strokeWidth="7" />
      <circle
        className="ln-b"
        cx="33"
        cy="33"
        r="26"
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(1)} ${(circumference - filled).toFixed(1)}`}
        transform="rotate(-90 33 33)"
      />
    </svg>
  );
}
