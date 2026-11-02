// When the card looks for a sent batch in the wallet, and when it hands a hash
// it found to Still. Kept apart from the component so both rules are tested.

/** The wallet is asked for the hashes of a batch it sent as soon as there is a
 * batch and the review has not reached its final state, read or not. */
export function stillCardLooksUpBatchV1(input: { paired: boolean; batchId: string | null; executionState: string | null; found: string | null }): boolean {
  return input.paired && Boolean(input.batchId) && input.found === null && input.executionState !== 'confirmed' && input.executionState !== 'failed';
}

/** A hash the wallet named is handed to Still once. A verification that stays
 * open is followed by the card's own status, never by sending the hash again. */
export function stillCardHandsHashV1(input: { found: string | null; hint: string; checking: boolean; handed: string | null }): boolean {
  return input.found !== null && input.hint === input.found && !input.checking && input.handed !== input.found;
}
