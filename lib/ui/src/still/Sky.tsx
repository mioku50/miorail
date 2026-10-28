import React from 'react';

import type { SkyPhaseV1 } from './skyState';

void React;

// ---------------------------------------------------------------------------
// The visual sky, drawn in the 390 x 310 frame the mobile hangs in. Its sun
// follows a fixed Europe/Berlin local-clock schedule, independently of US
// trading hours. Clouds still represent the reviewed earnings windows.
// ---------------------------------------------------------------------------

const SKYLINE_V1 =
  'M0 310 V292 H18 V284 H34 V296 H48 V274 H60 V268 H66 V274 H76 V290 H92 V280 H110 V300 H124 V286 H140 V264 H146 V256 H150 V264 H156 V282 H170 V292 H188 V278 H204 V272 H220 V288 H236 V294 H252 V276 H262 V266 H274 V276 H284 V298 H300 V284 H318 V290 H334 V274 H350 V282 H366 V294 H390 V310 Z';

const WINDOWS_V1: ReadonlyArray<readonly [number, number]> = [
  [51, 280], [56, 287], [143, 268], [147, 275], [98, 288], [213, 282], [257, 281], [266, 276], [338, 283], [342, 290],
];

/** The sun on its arc: the start of the visual day at left, its end at right. */
export function sunPointV1(share: number): { x: number; y: number } {
  const s = Math.min(1, Math.max(0, share));
  const u = 1 - s;
  return { x: u * u * 34 + 2 * u * s * 195 + s * s * 356, y: u * u * 124 + 2 * u * s * -36 + s * s * 124 };
}

function Cloud({ x, y, scale }: { x: number; y: number; scale: number }) {
  return (
    <g className="sky-cloud" transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="0" cy="10" rx="34" ry="13" />
      <ellipse cx="-14" cy="2" rx="16" ry="13" />
      <ellipse cx="10" cy="-2" rx="19" ry="16" />
    </g>
  );
}

export function SkyLayer({ phase, sunShare, openLabel, closeLabel, clouds }: {
  phase: SkyPhaseV1;
  sunShare: number | null;
  openLabel: string;
  closeLabel: string;
  clouds: number;
}) {
  const sun = phase === 'day' && sunShare !== null ? sunPointV1(sunShare) : null;
  return (
    <g className={`sky sky-${phase}`}>
      <rect className="sky-band-1" x="0" y="0" width="390" height="150" />
      <rect className="sky-band-2" x="0" y="150" width="390" height="82" />
      <rect className="sky-band-3" x="0" y="232" width="390" height="78" />
      {phase !== 'day' ? (
        <g className="sky-stars">
          {[[72, 30], [160, 22], [232, 96], [52, 104], [128, 128], [372, 118], [24, 176], [250, 170]].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.1" />
          ))}
        </g>
      ) : null}
      <path className="sky-path" d="M34 124 Q195 -36 356 124" />
      {sun ? (
        <g className="sky-sun">
          <circle className="sky-sun-halo" cx={sun.x.toFixed(1)} cy={sun.y.toFixed(1)} r="27" />
          <circle className="sky-sun-core" cx={sun.x.toFixed(1)} cy={sun.y.toFixed(1)} r="19" />
        </g>
      ) : null}
      {phase === 'night' ? (
        <g className="sky-moon">
          <circle className="sky-moon-face" cx="304" cy="62" r="22" />
          <circle className="sky-moon-shadow" cx="314" cy="54" r="19" />
        </g>
      ) : null}
      {clouds > 0 ? <Cloud x={92} y={46} scale={1} /> : null}
      {clouds > 1 ? <Cloud x={262} y={30} scale={0.8} /> : null}
      {clouds > 2 ? <Cloud x={178} y={88} scale={0.7} /> : null}
      <path className="sky-skyline" d={SKYLINE_V1} />
      {phase !== 'day' ? (
        <g className="sky-windows">
          {WINDOWS_V1.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="2" height="3" />)}
        </g>
      ) : null}
      <g className="sky-hours">
        <text x="34" y="142">{openLabel}</text>
        <text x="356" y="142">{closeLabel}</text>
      </g>
    </g>
  );
}
