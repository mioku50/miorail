import type { MobileInputV1 } from './homeView';

// ---------------------------------------------------------------------------
// The Calder mobile's geometry, in the 390 x 310 frame it shares with the sky.
//
// What you own hangs on the left, largest first, each on its own arm. What you
// owe hangs on the right: a solid square for the loan inside a dashed square
// for the limit. Circles are area-true against the largest holding, squares
// against the larger of today's limit and the open-market one, so a shape's
// size is a claim a reader can check against the numbers under it.
//
// The arms are the design's (docs: Sky mobile on the canvas): fixed hooks, so
// the picture is the same picture for every wallet, filled with its own sizes.
// ---------------------------------------------------------------------------

export interface MobileShapeV1 {
  id: string;
  kind: 'stock' | 'crypto' | 'more';
  cx: number;
  cy: number;
  r: number;
  label: string;
  /** Inside the shape when it fits, under it when it does not. */
  labelInside: boolean;
}

export interface MobileWireV1 {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
}

export interface MobileLayoutV1 {
  wires: MobileWireV1[];
  pivot: { x: number; y: number };
  shapes: MobileShapeV1[];
  /** The limit: owed plus what can still be taken. */
  limit: { x: number; y: number; side: number } | null;
  loan: { x: number; y: number; side: number } | null;
}

export const MOBILE_PIVOT_V1 = { x: 196, y: 160 };
const RIGHT_X = 346;
const LEFT_X = 82;
const HOOK_Y = 186;
const LARGEST_R = 34;
const SMALLEST_R = 8;
const LIMIT_SIDE = 76;
/** Per arm, the largest radius that keeps the shape inside the frame and off its neighbours. */
const ARM_MAX_R = [54, 34, 30, 24];

/** The arms, by how many holdings hang: where each one's wire starts and how far it drops. */
function hooksV1(count: number): { wires: MobileWireV1[]; hooks: Array<{ x: number; y: number }> } {
  const wire = (x1: number, y1: number, x2: number, y2: number, width = 1.5): MobileWireV1 => ({ x1, y1, x2, y2, width });
  if (count <= 1) return { wires: [wire(LEFT_X, 160, LEFT_X, HOOK_Y)], hooks: [{ x: LEFT_X, y: HOOK_Y }] };
  const wires = [wire(LEFT_X, 160, LEFT_X, HOOK_Y), wire(44, HOOK_Y, 176, HOOK_Y, 2), wire(44, HOOK_Y, 44, 198)];
  if (count === 2) return { wires: [...wires, wire(176, HOOK_Y, 176, 198)], hooks: [{ x: 44, y: 198 }, { x: 176, y: 198 }] };
  wires.push(wire(176, HOOK_Y, 176, 212), wire(126, 212, 256, 212, 2), wire(126, 212, 126, 222));
  if (count === 3) return { wires: [...wires, wire(256, 212, 256, 222)], hooks: [{ x: 44, y: 198 }, { x: 126, y: 222 }, { x: 256, y: 222 }] };
  wires.push(wire(256, 212, 256, 236), wire(210, 236, 284, 236, 2), wire(210, 236, 210, 244), wire(284, 236, 284, 244));
  return { wires, hooks: [{ x: 44, y: 198 }, { x: 126, y: 222 }, { x: 210, y: 244 }, { x: 284, y: 244 }] };
}

export function mobileLayoutV1(input: MobileInputV1): MobileLayoutV1 {
  const holdings = input.holdings.slice(0, 4);
  const { wires: arms, hooks } = hooksV1(holdings.length);
  const largest = Math.max(1, ...holdings.map((h) => h.valueCents));
  const shapes: MobileShapeV1[] = holdings.map((holding, index) => {
    const hook = hooks[index]!;
    const area = Math.max(0, holding.valueCents) / largest;
    const r = Math.min(ARM_MAX_R[index]!, Math.max(SMALLEST_R, LARGEST_R * Math.sqrt(area)));
    return {
      id: holding.id,
      kind: holding.kind,
      cx: hook.x,
      cy: hook.y + r,
      r: Math.round(r * 10) / 10,
      label: holding.label,
      labelInside: r >= 14,
    };
  });

  const wires: MobileWireV1[] = [
    { x1: MOBILE_PIVOT_V1.x, y1: 0, x2: MOBILE_PIVOT_V1.x, y2: MOBILE_PIVOT_V1.y, width: 1.5 },
    { x1: LEFT_X, y1: 160, x2: RIGHT_X, y2: 160, width: 2.5 },
    { x1: RIGHT_X, y1: 160, x2: RIGHT_X, y2: HOOK_Y, width: 1.5 },
    ...(holdings.length > 0 ? arms : []),
  ];

  let limit: MobileLayoutV1['limit'] = null;
  let loan: MobileLayoutV1['loan'] = null;
  if (input.loan) {
    const scale = Math.max(input.loan.limitCents, input.loan.weekdayLimitCents ?? 0, 1);
    const side = (cents: number) => Math.round(LIMIT_SIDE * Math.sqrt(Math.max(0, cents) / scale) * 10) / 10;
    const limitSide = side(input.loan.limitCents);
    limit = { x: RIGHT_X - limitSide / 2, y: HOOK_Y, side: limitSide };
    if (input.loan.owedCents > 0) {
      const loanSide = Math.max(4, side(input.loan.owedCents));
      loan = { x: RIGHT_X - loanSide / 2, y: HOOK_Y, side: loanSide };
    }
  }
  return { wires, pivot: MOBILE_PIVOT_V1, shapes, limit, loan };
}
