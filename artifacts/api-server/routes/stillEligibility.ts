import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { STILL_ELIGIBILITY_VERSION_V1 } from '@mioagent/still-engine/eligibility';
import { stillEligibilityReadV1, stillEntryGateV1, stillRegionRuntimeV1 } from '../lib/stillRegion.js';

// Where a page asks, before it offers a new loan, purchase or stock buy, what
// the server sees (the region, read from the browser's own request) and
// whether this sign-in confirmed that it is not a US person; and where it
// records that confirmation. See lib/stillRegion.ts.

export const publicStillEligibilityRouter = Router();
publicStillEligibilityRouter.get('/eligibility', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(stillEligibilityReadV1(req));
});

const ConfirmV1Schema = z.object({ version: z.literal(STILL_ELIGIBILITY_VERSION_V1) }).strict();

export const stillEligibilityRouter = Router();
stillEligibilityRouter.post('/eligibility', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = req.session?.user;
  if (!user || user.chainId !== 8453 || !/^0x[0-9a-f]{40}$/.test(user.address) || user.id !== `eip155:8453:${user.address}`) {
    res.status(401).json({ error: 'authentication_required' }); return;
  }
  if (!ConfirmV1Schema.safeParse(req.body).success) { res.status(400).json({ error: 'eligibility_request_invalid' }); return; }
  // From where Still is not offered, the sentence cannot be true; nothing is recorded.
  const gate = stillEntryGateV1(req, { kind: 'loan', confirmation: false });
  if (!gate.ok && gate.refusal === 'region_restricted') { res.status(403).json({ error: gate.refusal, detail: gate.detail }); return; }
  const confirmedAt = new Date(stillRegionRuntimeV1.now()).toISOString();
  req.session.stillEligibility = { version: STILL_ELIGIBILITY_VERSION_V1, wallet: user.address.toLowerCase(), confirmedAt };
  req.session.save(error => {
    if (error) { res.status(500).json({ error: 'eligibility_not_saved' }); return; }
    res.json({ confirmed: true, confirmedAt, version: STILL_ELIGIBILITY_VERSION_V1 });
  });
});
