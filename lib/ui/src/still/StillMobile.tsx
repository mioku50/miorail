import React from 'react';
import { formatCents } from '@mioagent/still-engine/format';

import type { MobileInputV1 } from './homeView';
import { mobileLayoutV1 } from './mobileLayout';

void React;

// ---------------------------------------------------------------------------
// The mobile itself. It hangs still while the loan is safe, sways while it
// leans (watch), and the loan turns red while it tips (act, liquidation). The
// motion stops for a reader who asked for less of it (still.css).
// ---------------------------------------------------------------------------

function moneyLabelV1(cents: number): string {
  return formatCents(BigInt(cents));
}

/** The picture is 390 units wide, and the label is set at 11px, weight 600: about 6.4 units a character. */
const PICTURE_WIDTH_V1 = 390, ROOM_LABEL_UNIT_V1 = 6.4, ROOM_LABEL_EDGE_V1 = 6;
/** Where a label centred on `centre` goes so that its right end stays inside the picture. */
export function roomLabelXV1(centre: number, label: string): number {
  const half = (label.length * ROOM_LABEL_UNIT_V1) / 2;
  return Math.round(Math.min(centre, PICTURE_WIDTH_V1 - ROOM_LABEL_EDGE_V1 - half) * 10) / 10;
}

export function StillMobile({ input }: { input: MobileInputV1 }) {
  const layout = mobileLayoutV1(input);
  const owed = input.loan?.owedCents ?? 0;
  const room = input.loan ? Math.max(0, input.loan.limitCents - owed) : 0;
  const roomLabel = `${layout.loan && layout.loan.side < 30 ? `owed ${moneyLabelV1(owed)} · ` : ''}room ${moneyLabelV1(room)}`;
  return (
    <g className="sm" data-state={input.state}>
      <g className="sm-swing">
        {layout.wires.map((wire, index) => (
          <line key={index} className="sm-wire" x1={wire.x1} y1={wire.y1} x2={wire.x2} y2={wire.y2} strokeWidth={wire.width} />
        ))}
        <circle className="sm-pivot" cx={layout.pivot.x} cy={layout.pivot.y} r="3.5" />
        {layout.limit ? (
          <rect className="sm-limit" x={layout.limit.x} y={layout.limit.y} width={layout.limit.side} height={layout.limit.side} />
        ) : null}
        {layout.loan ? (
          <rect className="sm-loan" x={layout.loan.x} y={layout.loan.y} width={layout.loan.side} height={layout.loan.side} />
        ) : null}
        {layout.loan && layout.loan.side >= 30 ? (
          <text className="sm-loan-label" x={layout.loan.x + layout.loan.side / 2} y={layout.loan.y + layout.loan.side / 2 + 4}>
            {input.loan?.owedLabel ?? moneyLabelV1(owed)}
          </text>
        ) : null}
        {layout.limit ? (
          // "room", not "model": beside a square that says $37.48, "model $0.00" read as the loan's own
          // modelled value (audit UI-2). The label is kept inside the picture: centred under the limit it ran
          // past the right edge on a phone from $1,000 up (audit UI-6).
          <text className="sm-room-label" x={roomLabelXV1(layout.limit.x + layout.limit.side / 2, roomLabel)} y={layout.limit.y + layout.limit.side + 16}>
            {roomLabel}
          </text>
        ) : null}
        {layout.shapes.map((shape) => (
          <g key={shape.id} className={`sm-holding sm-${shape.kind}`}>
            <circle cx={shape.cx} cy={shape.cy} r={shape.r} />
            <text
              className={shape.labelInside ? 'sm-label-in' : 'sm-label-under'}
              x={shape.cx}
              y={shape.labelInside ? shape.cy + Math.min(13, shape.r * 0.4) * 0.36 : shape.cy + shape.r + 11}
              style={{ fontSize: shape.labelInside ? Math.max(8, Math.min(13, shape.r * 0.4)) : 10 }}
            >
              {shape.label}
            </text>
          </g>
        ))}
      </g>
    </g>
  );
}
