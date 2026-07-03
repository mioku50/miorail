import { appManifest } from "@/manifest";

// Optional Farcaster distribution manifest (static JSON only — no Farcaster
// runtime SDK). Served at /.well-known/farcaster.json for Farcaster clients.
// Fill accountAssociation + baseBuilder via `npx create-onchain --manifest`
// after registering on base.dev (see README).
export async function GET() {
  return Response.json(appManifest);
}
