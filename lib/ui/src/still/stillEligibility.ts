import { STILL_ELIGIBILITY_STATEMENT_V1, STILL_ELIGIBILITY_VERSION_V1, STILL_REGION_OPEN_V1 } from '@mioagent/still-engine/eligibility';

// ---------------------------------------------------------------------------
// What a page says about where Still is offered, from what the server sees
// (GET /api/public/still/eligibility; artifacts/api-server/lib/stillRegion.ts).
// The server decides: these words only tell the person what it decided, and a
// page that never read them is refused by the server all the same.
// ---------------------------------------------------------------------------

export type StillEligibilityViewV1 =
  /** The connection comes from the United States or one of its territories. */
  | { kind: 'restricted'; country: string; place: string; detail: string }
  /** Still could not place the connection, so it prepares nothing new for now. */
  | { kind: 'unchecked'; detail: string }
  /** Signed in, from elsewhere, and not yet confirmed: the sentence to confirm. */
  | { kind: 'confirm'; statement: string; version: string }
  /** Nothing to say: confirmed, signed out elsewhere, or the check is off. */
  | { kind: 'clear' };

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 600;

/** The place a two-letter country code names, in English; the code itself when the browser cannot say. */
export function stillCountryNameV1(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

export function stillEligibilityViewV1(payload: unknown): StillEligibilityViewV1 | null {
  if (!object(payload) || payload.schemaVersion !== 'still-eligibility/v1' || !object(payload.region)) return null;
  if (payload.gate !== 'on') return { kind: 'clear' };
  const region = payload.region, open = text(payload.open) ? payload.open : STILL_REGION_OPEN_V1;
  if (region.state === 'restricted' && typeof region.country === 'string' && /^[A-Z]{2}$/.test(region.country)) {
    return { kind: 'restricted', country: region.country, place: stillCountryNameV1(region.country),
      detail: text(payload.restrictedDetail) ? payload.restrictedDetail : `Still prepares no new loan, purchase or stock buy for anyone in the United States, or for a US person. ${open}` };
  }
  if (region.state === 'unchecked') {
    return { kind: 'unchecked', detail: `Still could not tell where you are connecting from, so it prepares no new loan, purchase or stock buy right now. ${open}` };
  }
  if (region.state !== 'allowed') return null;
  if (payload.signedIn === true && payload.confirmed !== true) {
    // The server's sentence and its name, so a confirmation is always of the sentence the server checks.
    return { kind: 'confirm', statement: text(payload.statement) ? payload.statement : STILL_ELIGIBILITY_STATEMENT_V1,
      version: text(payload.version) ? payload.version : STILL_ELIGIBILITY_VERSION_V1 };
  }
  return { kind: 'clear' };
}

/** The server's own sentence for a region refusal (`code: detail`), or null for any other error. */
export function stillRegionRefusalDetailV1(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const found = /^(?:region_restricted|region_unchecked|eligibility_required): (.+)$/s.exec(message);
  return found ? found[1]! : null;
}
