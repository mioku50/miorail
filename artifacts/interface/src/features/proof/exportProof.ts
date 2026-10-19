// ---------------------------------------------------------------------------
// "Export proof": the owner's own copy of a route proof, as a JSON file.
//
// The button under a proof promised "exportable as JSON" and opened Activity,
// where nothing was exported either (2026-10-19). This writes down what the
// server returned for the proof — the proof, its lifecycle and its event
// chain — under the proof's own name. Nothing is fetched and nothing is
// published: a public link stays a separate, explicit act in Activity.
// ---------------------------------------------------------------------------

export const ROUTE_PROOF_EXPORT_SCHEMA_V1 = 'miorail-route-proof-export/v1';

export interface RouteProofExportFileV1 {
  fileName: string;
  json: string;
}

export function routeProofExportV1(input: {
  proof: { proofId: string };
  lifecycle: unknown;
  events: unknown;
  now?: Date;
}): RouteProofExportFileV1 {
  const body = {
    schemaVersion: ROUTE_PROOF_EXPORT_SCHEMA_V1,
    exportedAt: (input.now ?? new Date()).toISOString(),
    proof: input.proof,
    lifecycle: input.lifecycle ?? null,
    events: input.events ?? [],
  };
  // The same twelve characters the proof screen names it by.
  const name = input.proof.proofId.replace(/[^A-Za-z0-9]/g, '').slice(-12);
  return { fileName: `miorail-proof-${name}.json`, json: `${JSON.stringify(body, null, 2)}\n` };
}

/** Hands the file to the browser's own download. */
export function downloadRouteProofV1(file: RouteProofExportFileV1): void {
  const url = URL.createObjectURL(new Blob([file.json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
