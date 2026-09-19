// ---------------------------------------------------------------------------
// Administrative seizure, in the reader's words — and in TWO answers, never one.
//
// Cobalt gives an issuer `seizeWithMemo`: a balance moves out of a holder's
// address to a destination, without their signature, without an allowance, and
// skipping all three transfer policies. So everything the Stocks screen already
// says about whether a wallet may move a token says nothing about this.
//
// WHY THERE IS NO SINGLE CHIP
//
// Whether a particular seizure would succeed depends on the role its caller
// holds, the SEIZE pause bit, the exemption policy, the destination policy, the
// balance, and a documented precedence between them. Miorail cannot read role
// membership at all — it is not enumerable — so:
//
//   a green "your tokens are safe" would be unprovable, and
//   a red "the issuer can take your tokens" would be a claim about a call
//   nobody made.
//
// Both are the failure in [[colour-is-a-claim]]. What this renders instead is
// what was measured, in the order a reader needs it, and the tones stay
// neutral: this is a disclosure about the instrument, not a warning about a
// transaction.
//
// AND CAPABILITY IS NOT OCCURRENCE
//
// `capability` is what is configured. `occurrences` is what has happened. They
// are two sections with two headings, because "the issuer could do this" and
// "the issuer has done this" are different facts and a holder is owed both
// separately. A token where seizure is armed and has never been used is the
// ordinary case for a regulated asset, and collapsing it into one line would
// read as an accusation.
// ---------------------------------------------------------------------------

export interface SeizeWireV1 {
  surface?: string | null;
  arming?: string | null;
  pause?: string | null;
  exemptPolicy?: { policyId?: string | null; exists?: boolean | null; reason?: string | null } | null;
  receiverPolicy?: { policyId?: string | null; exists?: boolean | null; reason?: string | null } | null;
  holder?: { address?: string | null; outcome?: string | null; reason?: string | null } | null;
  receiver?: { address?: string | null; outcome?: string | null; reason?: string | null } | null;
}

/** What the record covers, so "none found" can be a measurement. */
export interface SeizeOccurrenceWireV1 {
  /** Seizures recorded in the range below. */
  events?: readonly {
    from?: string | null;
    to?: string | null;
    amount?: string | null;
    blockNumber?: number | null;
    blockTime?: string | null;
    transactionHash?: string | null;
  }[];
  /** The block range actually read. Null when nobody has looked. */
  fromBlock?: number | null;
  toBlock?: number | null;
}

export interface SeizeLineV1 {
  text: string;
  tone: 'neutral' | 'off' | 'warn';
}

export interface SeizeViewV1 {
  capability: { title: string; lines: readonly SeizeLineV1[] };
  occurrences: { title: string; lines: readonly SeizeLineV1[] };
}

const NEUTRAL_V1 = 'neutral' as const;

function shortV1(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The two sections, assembled.
 *
 * Returns null only when the surface was never read at all — a section headed
 * "Administrative seizure" with nothing under it would invite the reader to
 * infer the absence of the power rather than the absence of a reading.
 */
export function seizeViewV1(input: {
  configuration: SeizeWireV1 | null | undefined;
  occurrences?: SeizeOccurrenceWireV1 | null;
}): SeizeViewV1 | null {
  const config = input.configuration ?? null;
  if (config === null) return null;

  const lines: SeizeLineV1[] = [];
  const surface = config.surface ?? null;

  if (surface === 'not_on_this_deployment') {
    lines.push({
      text: 'This contract has no administrative seizure function.',
      tone: NEUTRAL_V1,
    });
    return {
      capability: { title: 'Administrative seizure', lines },
      occurrences: occurrencesSectionV1(input.occurrences ?? null, false),
    };
  }
  if (surface !== 'available') {
    lines.push({
      text: 'Miorail could not read whether this contract has an administrative seizure function.',
      tone: NEUTRAL_V1,
    });
    return {
      capability: { title: 'Administrative seizure', lines },
      occurrences: occurrencesSectionV1(input.occurrences ?? null, false),
    };
  }

  // Armed or not. This is about the TOKEN, and it is stated before anything
  // about an address so a reader cannot mistake one for the other.
  const arming = config.arming ?? null;
  if (arming === 'unconfigured') {
    lines.push({
      text:
        'The issuer has not set up seizure on this token. With the rule unset, no address can be seized and the function reverts.',
      tone: NEUTRAL_V1,
    });
  } else if (arming === 'armed') {
    lines.push({
      text:
        'The issuer has set up a rule naming which addresses can be seized. Whether any particular address is in that set is the separate answer below.',
      tone: NEUTRAL_V1,
    });
  } else {
    lines.push({
      text: 'Miorail could not read whether the issuer has set up seizure on this token.',
      tone: NEUTRAL_V1,
    });
  }

  // THE INVERSION, in plain words. "Authorized by the exemption policy" is the
  // protected state, and the reader is never shown the word "authorized" for it.
  const holder = config.holder ?? null;
  if (holder?.address) {
    const address = shortV1(holder.address);
    if (holder.outcome === 'exempt') {
      lines.push({
        text: `${address} is outside that rule, so this contract cannot seize from it.`,
        tone: NEUTRAL_V1,
      });
    } else if (holder.outcome === 'seizable') {
      lines.push({
        text: `${address} is inside that rule. A holder of the issuer's seize role could move this balance without a signature from it.`,
        // `warn` and never `bad`: it is a property of the instrument the issuer
        // publishes, not something that has gone wrong.
        tone: 'warn',
      });
    } else {
      lines.push({
        text: `Miorail could not establish whether ${address} is inside that rule.`,
        tone: NEUTRAL_V1,
      });
    }
  }

  const receiver = config.receiver ?? null;
  if (receiver?.address) {
    const address = shortV1(receiver.address);
    if (receiver.outcome === 'permitted') {
      lines.push({ text: `A seizure could send the balance to ${address}.`, tone: NEUTRAL_V1 });
    } else if (receiver.outcome === 'refused') {
      lines.push({
        text: `The issuer's rules do not permit ${address} as a seizure destination.`,
        tone: NEUTRAL_V1,
      });
    }
  }

  if (config.pause === 'paused') {
    lines.push({
      text: 'Seizure is paused on this contract right now. A pause can be lifted.',
      tone: NEUTRAL_V1,
    });
  } else if (config.pause === 'not_established') {
    lines.push({ text: 'Miorail could not read the seizure pause.', tone: NEUTRAL_V1 });
  }

  // What was NOT checked. The precondition Miorail cannot read at all, said
  // where a reader would otherwise assume it was covered.
  lines.push({
    text:
      'Not checked: who holds the issuer’s seize role. That cannot be listed from the chain, so nothing here says whether anyone is in a position to use this.',
    tone: NEUTRAL_V1,
  });

  return {
    capability: { title: 'Administrative seizure', lines },
    occurrences: occurrencesSectionV1(input.occurrences ?? null, true),
  };
}

function occurrencesSectionV1(
  wire: SeizeOccurrenceWireV1 | null,
  surfaceExists: boolean,
): SeizeViewV1['occurrences'] {
  const title = 'Seizures on record';
  if (wire === null || wire.fromBlock == null || wire.toBlock == null) {
    return {
      title,
      lines: [
        {
          // Nobody has looked is not nothing happened — the distinction this
          // whole vertical is organised around.
          text: 'Miorail has not read this contract’s seizure history.',
          tone: NEUTRAL_V1,
        },
      ],
    };
  }
  const events = wire.events ?? [];
  if (events.length === 0) {
    return {
      title,
      lines: [
        {
          text: surfaceExists
            ? `No seizure has been recorded on this contract in the blocks Miorail has read (${wire.fromBlock.toLocaleString()}–${wire.toBlock.toLocaleString()}).`
            : `No seizure has been recorded in the blocks Miorail has read (${wire.fromBlock.toLocaleString()}–${wire.toBlock.toLocaleString()}).`,
          tone: NEUTRAL_V1,
        },
      ],
    };
  }
  return {
    title,
    lines: events.map((event) => ({
      text: `${event.blockTime ? new Date(event.blockTime).toISOString().slice(0, 10) : 'An unknown date'}: a balance was moved from ${event.from ? shortV1(event.from) : 'an address'} to ${event.to ? shortV1(event.to) : 'an address'} by the issuer.`,
      tone: 'warn' as const,
    })),
  };
}
