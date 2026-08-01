import {
  BASE_CHAIN_ID_V1,
  O1_SIGNATURE_PLACEHOLDER_V1,
  type O1CompatibilityFindingV1,
  type O1TradingOrderResponseV1,
} from './contracts.js';

// ---------------------------------------------------------------------------
// T67D §5–§11 — the checks.
//
// Two kinds of finding live here and they must not be confused.
//
//   * SPEC findings come from the published specification and the official
//     sample implementation. They hold regardless of what any live response
//     contains, because they describe what the integration REQUIRES.
//   * RESPONSE findings come from decoding an actual order batch. They can only
//     make the verdict worse, never better: a well-formed response does not
//     un-require `signTransaction`.
//
// Every check fails closed. `unknown` is a real outcome and is never rounded up
// to `compatible` — "we could not determine it" and "it is fine" are different
// sentences and only one of them is honest.
// ---------------------------------------------------------------------------

/** Selectors Miorail can decode today. A swap Miorail cannot read is a swap
 * Miorail cannot let a user approve. */
const KNOWN_SELECTORS_V1 = new Set([
  '0x095ea7b3', // approve(address,uint256)
  '0x2b67b570', // permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)
  '0x3593564c', // execute(bytes,bytes[],uint256) — Universal Router
]);

const UNLIMITED_APPROVAL_THRESHOLD_V1 =
  BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') / 2n;

function finding(input: O1CompatibilityFindingV1): O1CompatibilityFindingV1 {
  return input;
}

/**
 * §6 / §11 — the findings that come from the specification itself.
 *
 * These are the ones that decide the verdict. They are stated as constants
 * rather than derived from a response because they are properties of the
 * PROTOCOL: no order batch, however well-formed, removes the need for a raw
 * private key.
 */
export function specFindingsV1(): O1CompatibilityFindingV1[] {
  return [
    finding({
      id: 'server_side_api_auth',
      category: 'authentication',
      status: 'compatible',
      severity: 'info',
      evidence: 'Authorization: Bearer <token> on POST https://api.o1.exchange/api/v2/order',
      reason:
        'A server-side bearer token against a pinned host is the same shape Miorail already uses for OpenSea and Moonwell. The token never reaches a client.',
      requiredChange: null,
    }),
    finding({
      id: 'requires_user_private_key',
      category: 'custody',
      status: 'incompatible',
      severity: 'blocker',
      evidence:
        'sampleScripts/execute-trade-interactive.js: `const PRIVATE_KEY = process.env.EXECUTE_TRADE_PRIVATE_KEY` then `new Wallet(PRIVATE_KEY)`',
      reason:
        'The documented flow signs with an EOA key held by the integrator. Miorail holds no user key. This is not a configuration difference but the opposite custody model.',
      requiredChange: null,
    }),
    finding({
      id: 'requires_raw_transaction_signing',
      category: 'wallet_signing',
      status: 'incompatible',
      severity: 'blocker',
      evidence: 'sampleScripts/execute-trade-interactive.js: `await wallet.signTransaction(unsignedTx)`',
      reason:
        'A Base Account is an ERC-4337 smart wallet. It signs user operations, not raw transactions; there is no primitive that produces the signed RLP transaction o1 expects back. No adapter shape bridges this.',
      requiredChange:
        'o1 would have to accept calls executed by the user\'s own wallet, as its DEX Aggregator API already does.',
    }),
    finding({
      id: 'requires_provider_broadcast',
      category: 'submission',
      status: 'incompatible',
      severity: 'blocker',
      evidence: 'POST /api/v2/order/complete accepts `signed` and returns `{ hash, status, tokenDelta }`',
      reason:
        'o1 puts the transaction on chain. Miorail never issues wallet_sendCalls and therefore never receives a Base Account batch id — the handle the whole submission path is built on.',
      requiredChange: null,
    }),
    finding({
      id: 'calldata_mutated_after_quote',
      category: 'calldata_validation',
      status: 'incompatible',
      severity: 'blocker',
      evidence:
        'sampleScripts/execute-trade-interactive.js: `data = data.replace(SIGNATURE_PLACEHOLDER, signature.slice(2))`',
      reason:
        'The Permit2 signature is substituted into the provider\'s calldata after the quote. The bytes that execute are not the bytes that were quoted, so a Review and a simulation performed before substitution describe something that will not run.',
      requiredChange:
        'The final bytes would have to be fixed before Review, so simulation and approval cover exactly what executes.',
    }),
    finding({
      id: 'cannot_simulate_final_bytes',
      category: 'simulation',
      status: 'incompatible',
      severity: 'blocker',
      evidence:
        'Substitution happens client-side after signTypedData and immediately before signTransaction; there is no step between it and broadcast.',
      reason:
        'Alchemy eth_simulateV1 is a hard precondition for server-written calldata. There is no point in this flow where the exact final bytes exist and can still be simulated before execution.',
      requiredChange: null,
    }),
    finding({
      id: 'builder_code_cannot_survive',
      category: 'builder_attribution',
      status: 'incompatible',
      severity: 'blocker',
      evidence:
        'ERC-8021 appends a suffix to the outer call; o1 receives a fully signed raw transaction.',
      reason:
        'Appending a suffix to a signed transaction invalidates the signature; appending it before signing changes the bytes o1 expects back. There is no ordering in which the attribution is both present and valid.',
      requiredChange: null,
    }),
    finding({
      id: 'cannot_reconcile_onchain_result',
      category: 'route_proof',
      status: 'incompatible',
      severity: 'blocker',
      evidence: '/order/complete returns a provider-reported `hash` and `tokenDelta`.',
      reason:
        'Route Proof binds approvedCallsHash → batchId → receipts → actual delta. Without a batch id and without Miorail observing the submission, the chain breaks at its first link. A provider response is not a proof.',
      requiredChange: null,
    }),
    finding({
      id: 'submission_recovery_unavailable',
      category: 'recovery',
      status: 'incompatible',
      severity: 'blocker',
      evidence: 'No Base Account batch id is produced anywhere in the flow.',
      reason:
        'T67C.2 recovery resolves an unknown submission by its batch id. With provider-side broadcast there is nothing to recover against, and re-sending would be a second execution path.',
      requiredChange: null,
    }),
    finding({
      id: 'atomicity_unspecified',
      category: 'atomicity',
      status: 'unknown',
      severity: 'major',
      evidence: 'The response carries `transactions[]` with no documented atomicity guarantee.',
      reason:
        'Multiple separately-signed raw transactions are not an atomic batch. Whether o1 broadcasts them atomically is not stated, and an unstated guarantee is not a guarantee.',
      requiredChange: null,
    }),
    finding({
      id: 'quote_evidence_absent',
      category: 'quote_evidence',
      status: 'incompatible',
      severity: 'major',
      evidence:
        'The documented response carries no expectedOutput, minimumOutput, fee breakdown, price impact, route sources, quote expiry or block number.',
      reason:
        'Without a minimum output there is no floor to check a receipt against, and without an expected output there is no Net Result. A RouteCandidateV1 built from this would be numbers Miorail invented.',
      requiredChange:
        'The order response would have to carry expected and minimum output, fees and a block anchor.',
    }),
    finding({
      id: 'quote_freshness_absent',
      category: 'freshness',
      status: 'unknown',
      severity: 'major',
      evidence: 'No quote expiry and no block number are returned.',
      reason:
        'Miorail expires a Review on the quote clock. A quote with no stated validity cannot be expired honestly, and treating it as fresh forever is the failure this check exists to prevent.',
      requiredChange: null,
    }),
    finding({
      id: 'mev_protection_is_a_claim',
      category: 'quote_evidence',
      status: 'unknown',
      severity: 'minor',
      evidence: '`mevProtection: true` is a REQUEST input; no returned artefact attests to private routing.',
      reason:
        'A marketing statement is not evidence. This can be surfaced only as provider_claimed with verification unavailable, and must stay Not scored.',
      requiredChange:
        'A verifiable artefact — a private-relay receipt or an inclusion proof — would be needed before this could score.',
    }),
    finding({
      id: 'permit2_parameters_undocumented',
      category: 'permit2',
      status: 'unknown',
      severity: 'major',
      evidence: 'permit2.eip712 is typed as `{ domain: object, types: object, values: object }`.',
      reason:
        'Amount, spender, nonce, expiration and sigDeadline are not specified, so the fail-closed allowance checks cannot be satisfied from the documentation alone.',
      requiredChange: 'The typed-data parameters would have to be specified and bounded.',
    }),
    finding({
      id: 'eip1271_support_unstated',
      category: 'permit2',
      status: 'unknown',
      severity: 'major',
      evidence: 'The specification does not state whether the Permit2 typed data is accepted from a contract wallet.',
      reason:
        'A Base Account signs via EIP-1271. Whether o1 and Permit2 accept that signature here is undetermined, and assuming it would be assuming the thing under test.',
      requiredChange: null,
    }),
    finding({
      id: 'chain_binding_not_guaranteed',
      category: 'transaction_format',
      status: 'unknown',
      severity: 'major',
      evidence:
        'The documented request shows networkId 8453 while the documented unsigned response example shows chainId 1.',
      reason:
        'Whether that is a documentation slip or real behaviour cannot be told from the specification, so chain binding has to be re-checked on every response rather than assumed.',
      requiredChange: null,
    }),
  ];
}

/** §5 — checks that need an actual response. */
export function responseFindingsV1(
  response: O1TradingOrderResponseV1,
  expected: { networkId: number; signerAddress: string },
): O1CompatibilityFindingV1[] {
  const findings: O1CompatibilityFindingV1[] = [];

  if (expected.networkId !== BASE_CHAIN_ID_V1) {
    findings.push(
      finding({
        id: 'request_not_base',
        category: 'transaction_format',
        status: 'incompatible',
        severity: 'blocker',
        evidence: `request networkId=${expected.networkId}`,
        reason: 'Miorail routes Base mainnet only. A request for another chain is out of scope by construction.',
        requiredChange: 'Request networkId 8453.',
      }),
    );
  }

  for (const [index, entry] of response.transactions.entries()) {
    const at = `transactions[${index}]`;

    if (entry.unsigned.chainId !== BASE_CHAIN_ID_V1) {
      findings.push(
        finding({
          id: `provider_chain_mismatch_${index}`,
          category: 'transaction_format',
          status: 'incompatible',
          severity: 'blocker',
          evidence: `${at}.unsigned.chainId=${entry.unsigned.chainId} for a networkId=${expected.networkId} request`,
          reason:
            'The provider returned a transaction bound to a different chain than the one requested. Signing it would authorise something on a chain the user never chose.',
          requiredChange: null,
        }),
      );
    }

    const selector = entry.unsigned.data.slice(0, 10).toLowerCase();
    if (entry.unsigned.data.length < 10) {
      findings.push(
        finding({
          id: `opaque_provider_calldata_${index}`,
          category: 'calldata_validation',
          status: 'incompatible',
          severity: 'blocker',
          evidence: `${at}.unsigned.data is shorter than a selector`,
          reason: 'Calldata that cannot be decoded cannot be reviewed, and an unreviewable call is not approvable.',
          requiredChange: null,
        }),
      );
    } else if (!KNOWN_SELECTORS_V1.has(selector)) {
      findings.push(
        finding({
          id: `opaque_provider_calldata_${index}`,
          category: 'calldata_validation',
          status: 'incompatible',
          severity: 'blocker',
          evidence: `${at}.unsigned.data selector ${selector} is not decodable by Miorail`,
          reason:
            'Miorail shows the user what a call does. A selector it cannot decode would be presented as a shape rather than a meaning, which is exactly the review a user cannot give.',
          requiredChange: 'Add a validated decoder for this selector, or have the provider return a known one.',
        }),
      );
    }

    if (selector === '0x095ea7b3') {
      const amountWord = entry.unsigned.data.slice(74, 138);
      if (amountWord.length === 64) {
        const amount = BigInt(`0x${amountWord}`);
        if (amount > UNLIMITED_APPROVAL_THRESHOLD_V1) {
          findings.push(
            finding({
              id: `unbounded_approval_${index}`,
              category: 'allowance',
              status: 'incompatible',
              severity: 'blocker',
              evidence: `${at} approves 0x${amountWord}`,
              reason:
                'An effectively unlimited allowance outlives the trade that asked for it. Miorail approves the amount a route needs and no more.',
              requiredChange: 'Return an exact approval for the traded amount.',
            }),
          );
        }
      }
    }

    const placeholderCount = countOccurrencesV1(
      entry.unsigned.data.toLowerCase(),
      O1_SIGNATURE_PLACEHOLDER_V1.toLowerCase(),
    );
    if (placeholderCount > 1) {
      findings.push(
        finding({
          id: `ambiguous_signature_placeholder_${index}`,
          category: 'permit2',
          status: 'incompatible',
          severity: 'blocker',
          evidence: `${at}.unsigned.data contains the signature placeholder ${placeholderCount} times`,
          reason:
            'With more than one occurrence there is no single site to substitute, so which bytes the signature lands in is undetermined.',
          requiredChange: null,
        }),
      );
    }
    if (placeholderCount === 1) {
      findings.push(
        finding({
          id: `signature_placeholder_present_${index}`,
          category: 'permit2',
          status: 'incompatible',
          severity: 'blocker',
          evidence: `${at}.unsigned.data contains the fixed Permit2 signature placeholder`,
          reason:
            'The calldata is incomplete until a signature is written into it, so what was quoted is not what will execute.',
          requiredChange: null,
        }),
      );
    }
  }

  return findings;
}

export function countOccurrencesV1(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * §8 — the B20 preflight verdict, folded in as a finding.
 *
 * `not_b20` is a NORMAL result for an ordinary ERC-20 and must not read as a
 * failure; a blocked transfer policy makes the route unavailable; an
 * unsupported variant is Not evaluated, which is not the same as safe.
 */
export function b20FindingV1(
  verdict: 'not_b20' | 'clear' | 'blocked' | 'unsupported_variant' | 'not_run',
): O1CompatibilityFindingV1 {
  switch (verdict) {
    case 'blocked':
      return finding({
        id: 'b20_transfer_blocked',
        category: 'b20_controls',
        status: 'incompatible',
        severity: 'blocker',
        evidence: 'B20 inspector reports a paused or blocked transfer policy for the traded token',
        reason: 'A token that cannot move cannot be routed. No order request may be sent for it.',
        requiredChange: null,
      });
    case 'unsupported_variant':
      return finding({
        id: 'b20_not_evaluated',
        category: 'b20_controls',
        status: 'unknown',
        severity: 'major',
        evidence: 'B20 inspector reports an unsupported variant',
        reason: 'Not evaluated is not safe. The controls could not be read, so nothing about them is established.',
        requiredChange: null,
      });
    case 'not_b20':
      return finding({
        id: 'b20_not_applicable',
        category: 'b20_controls',
        status: 'compatible',
        severity: 'info',
        evidence: 'B20 inspector reports not_b20 for the traded token',
        reason:
          'An ordinary ERC-20 has no B20 control surface. This is a normal, passing result and not a gap.',
        requiredChange: null,
      });
    case 'clear':
      return finding({
        id: 'b20_controls_clear',
        category: 'b20_controls',
        status: 'compatible',
        severity: 'info',
        evidence: 'B20 inspector reports no paused features or blocking transfer policy at the pinned block',
        reason: 'The controls were read and permit the intended action at a named block.',
        requiredChange: null,
      });
    default:
      return finding({
        id: 'b20_preflight_not_run',
        category: 'b20_controls',
        status: 'unknown',
        severity: 'major',
        evidence: 'No B20 snapshot was taken for this subject',
        reason:
          'The preflight is a precondition of an order request, so a report without it has not established the token is routable.',
        requiredChange: 'Run the B20 inspector for the token and quote token before requesting an order.',
      });
  }
}
