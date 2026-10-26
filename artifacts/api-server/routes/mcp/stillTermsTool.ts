import { stillTerms, StillTermsSchema } from '@mioagent/still-engine';
import { z } from 'zod';

import { publicStillRuntimeV1 } from '../stillPublic.js';
import { McpPublicError } from './tools.js';

export { StillTermsSchema };
export const StillTermsInputV1Schema = z.object({}).strict();

/** The same calendar service/cache, clock and builder as the public terms
 * endpoint. An unread calendar is a valid conservative answer, not a failure
 * and never a claim that no company reports earnings. */
export async function miorailGetStillTermsV1() {
  try {
    const read = await publicStillRuntimeV1.service().earnings();
    return StillTermsSchema.parse(stillTerms(read, publicStillRuntimeV1.now()));
  } catch {
    throw new McpPublicError('still_terms_unavailable',
      'Still could not read its terms right now. No borrowing limit is established by this failure.');
  }
}
