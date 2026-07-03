// Minimal className joiner — no external deps. Does NOT dedupe conflicting
// Tailwind utilities (callers should not override a primitive's base spacing).
export type ClassValue = string | number | false | null | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const v of inputs) {
    if (!v && v !== 0) continue;
    if (Array.isArray(v)) {
      const s = cn(...v);
      if (s) out.push(s);
    } else {
      out.push(String(v));
    }
  }
  return out.join(' ');
}
