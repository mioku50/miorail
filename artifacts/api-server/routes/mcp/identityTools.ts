import {
  AddressIdentityCheckInputV1Schema,
  AddressIdentityCheckOutputV1Schema,
  assembleAddressIdentityCheckV1,
  type AddressIdentityCheckInputV1,
  type AddressIdentityCheckOutputV1,
} from '@mioagent/rwa-dossier/identity-check';
import {
  createDatabaseIssuerRepresentationRepository,
  createDatabaseOfficialAssetRepository,
  createDatabaseOfficialLookalikeRepository,
} from '@mioagent/route-storage';

import { client } from '@mioagent/db';

import { McpPublicError } from './tools.js';

export { AddressIdentityCheckInputV1Schema, AddressIdentityCheckOutputV1Schema };

// ---------------------------------------------------------------------------
// `check_address_identity` — the one public read that takes an address nobody
// has reviewed.
//
// Every other tool on this server refuses an address outside the reviewed
// corpus, and correctly: each of them fans out to chain calls and HTTP fetches
// a caller could otherwise aim anywhere. This one is the exception BECAUSE it
// is the question an unreviewed address is asked with. Refusing "is this the
// real AAPLc" for an address not in the corpus would refuse exactly the case
// the tool exists for, and the refusal would read as an answer.
//
// It is safe to take any address because it does no work: two indexed lookups
// against stored rows, no chain read, no provider, nothing a caller can aim.
// An address nothing has been written about returns `unknown_to_miorail`,
// which is a statement about this corpus and never about the token.
// ---------------------------------------------------------------------------

export const identityCheckRuntime = {
  deps: () => ({
    official: createDatabaseOfficialAssetRepository(client),
    lookalikes: createDatabaseOfficialLookalikeRepository(client),
    issuers: createDatabaseIssuerRepresentationRepository(client),
    now: () => new Date(),
  }),
};

export async function miorailCheckAddressIdentityV1(
  args: unknown,
): Promise<AddressIdentityCheckOutputV1> {
  let input: AddressIdentityCheckInputV1;
  try {
    input = AddressIdentityCheckInputV1Schema.parse(args);
  } catch {
    throw new McpPublicError(
      'exact_address_required',
      'This tool takes one EXACT Base contract address on chain 8453. A ticker or a company name cannot select a contract — different issuers publish different contracts for the same company, and the address is the identity.',
    );
  }
  try {
    return await assembleAddressIdentityCheckV1(identityCheckRuntime.deps(), input);
  } catch {
    throw new McpPublicError(
      'identity_check_unavailable',
      // Never the provider's sentence: a database message must not become a
      // statement about somebody's token.
      'Miorail could not read its own stored corpus for this address, so it has no answer. That is an outage here and says nothing about the token.',
    );
  }
}
