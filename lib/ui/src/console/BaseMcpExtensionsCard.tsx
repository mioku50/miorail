// ---------------------------------------------------------------------------
// Base MCP's core tools, and what each one is allowed to do here.
//
// These are the calls the Base MCP server itself exposes — get_portfolio,
// send, swap, sign — read live from the endpoint, so a tool Base adds shows up
// here on the next read without anyone shipping a release.
//
// They are NOT the plugins. This card was headed "Base MCP plugins" for a
// release and listed none: the plugins are published specs and live in
// BaseMcpPluginsCard next to this one. Two layers, two cards, two headings.
//
// Two facts decide this screen:
//
//   * Base does not operate, endorse or audit what these tools reach. They
//     touch other people's protocols, with the user's wallet.
//   * A write tool does not execute anything itself. It returns an approval
//     URL, and the user approves in Base Account — outside Miorail entirely.
//
// So this card LISTS and CLASSIFIES; it does not become a second execution
// path. Miorail already has exactly one way to put calls in front of a wallet
// (`useSubmitApprovedBlueprint`), and routing an approval URL through anything
// that looked like it would mean two paths with one of them unaudited.
//
// The capability is therefore the headline of every row, not a footnote:
//
//   read_only                    safe to call; reads and returns
//   user_confirmed_transaction   hands back an approval URL for Base Account
//   forbidden                    never called from here, at all
//   unknown                      unclassified, and treated as forbidden
//
// `unknown` deserves its name. A tool the classifier has never seen might be a
// read, and might move money. Showing it as available because it is probably
// harmless is precisely the assumption a catalogue of third-party code should
// never make — and it is the case that grows, because the list is live.
// ---------------------------------------------------------------------------

export type BaseMcpCapabilityV1 =
  | 'read_only'
  | 'user_confirmed_transaction'
  | 'forbidden'
  | 'unknown';

export type BaseMcpStatusV1 = 'connected' | 'needs_reauth' | 'unreachable' | 'degraded';

export interface BaseMcpToolRowV1 {
  name: string;
  description?: string;
  capability: BaseMcpCapabilityV1;
  scope: 'wallet' | 'protocol';
}

export interface BaseMcpExtensionsModelV1 {
  /** Off on this server. Nothing was asked and nothing is claimed. */
  enabled: boolean;
  loading: boolean;
  /** Null until the catalogue has been read at least once. */
  status: BaseMcpStatusV1 | null;
  endpointHost?: string | null;
  tools: readonly BaseMcpToolRowV1[];
  /** Rendered INSTEAD of any list. Never alongside a partial one. */
  unavailableReason: string | null;
  onConnect?: () => void;
  onRefresh?: () => void;
}

/** What each capability means, in the user's terms. One sentence, because it
 * has to be readable next to a tool nobody has heard of. */
export const BASE_MCP_CAPABILITY_COPY_V1: Readonly<Record<BaseMcpCapabilityV1, string>> = {
  read_only: 'Reads only. Returns data and moves nothing.',
  user_confirmed_transaction:
    'Prepares a transaction and hands back an approval link. You approve it in Base Account — Miorail never signs or sends it.',
  forbidden: 'Not callable from Miorail.',
  unknown:
    'Not classified. Treated as not callable, because a tool nobody has categorised might move money.',
};

/** The order a reader should meet them in: what works, then what needs you,
 * then what will not run. */
const CAPABILITY_ORDER_V1: readonly BaseMcpCapabilityV1[] = [
  'read_only',
  'user_confirmed_transaction',
  'unknown',
  'forbidden',
];

export function groupBaseMcpToolsV1(
  tools: readonly BaseMcpToolRowV1[],
): { capability: BaseMcpCapabilityV1; tools: BaseMcpToolRowV1[] }[] {
  return CAPABILITY_ORDER_V1.map((capability) => ({
    capability,
    tools: tools
      .filter((tool) => tool.capability === capability)
      .sort((left, right) => left.name.localeCompare(right.name)),
  })).filter((group) => group.tools.length > 0);
}

/** The one line at the top. It says what state the connection is in, in words
 * that tell the user whether to act. */
export function baseMcpStatusCopyV1(status: BaseMcpStatusV1 | null, enabled: boolean): string {
  if (!enabled) return 'Base MCP is switched off on this server.';
  switch (status) {
    case 'connected':
      return 'Connected to Base MCP with your Base Account.';
    case 'needs_reauth':
      return 'Your Base MCP session expired. Connect again to keep using it.';
    case 'unreachable':
      // Not a claim about the plugins: we could not ask.
      return 'Base MCP did not answer. Nothing here is a statement about which tools exist.';
    case 'degraded':
      return 'Base MCP answered only partly, so this list may be incomplete.';
    default:
      return 'Not connected. Connecting uses your own Base Account.';
  }
}

/** console.css gives `.pill` exactly four tones — br, g, a, n. Anything else
 * renders as unstyled text, which is how a "forbidden" badge would end up
 * looking identical to a safe one. */
const CAPABILITY_TONE_V1: Readonly<Record<BaseMcpCapabilityV1, string>> = {
  read_only: 'g',
  user_confirmed_transaction: 'a',
  forbidden: 'n',
  unknown: 'n',
};

export function BaseMcpExtensionsCard(model: BaseMcpExtensionsModelV1) {
  const groups = groupBaseMcpToolsV1(model.tools);
  const statusCopy = baseMcpStatusCopyV1(model.status, model.enabled);

  return (
    <div className="rp">
      <div className="rph">
        <b>Base MCP tools</b>
        {model.endpointHost && <span className="rt mono">{model.endpointHost}</span>}
      </div>
      <div className="rpb">
        <p className="lnote">{statusCopy}</p>

        {model.enabled && (
          <div className="ctarow">
            {model.onConnect && (
              <button type="button" className="btn" onClick={model.onConnect}>
                {model.status === 'connected' ? 'Reconnect' : 'Connect Base Account'}
              </button>
            )}
            {model.onRefresh && model.status === 'connected' && (
              <button type="button" className="btn sec" onClick={model.onRefresh} disabled={model.loading}>
                {model.loading ? 'Reading…' : 'Refresh list'}
              </button>
            )}
          </div>
        )}

        {!model.enabled ? null : model.loading && groups.length === 0 ? (
          <p className="empty">Reading the tool catalogue…</p>
        ) : model.unavailableReason ? (
          <p className="empty">{model.unavailableReason}</p>
        ) : groups.length === 0 ? (
          <p className="empty">
            No tools have been read yet. Connect your Base Account to see what is available.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.capability}>
              <div className="qrow">
                <span>
                  <span className={`pill ${CAPABILITY_TONE_V1[group.capability]}`}>
                    {group.capability.replace(/_/g, ' ')}
                  </span>
                </span>
                <span className="v mono">{group.tools.length}</span>
              </div>
              <p className="lnote">{BASE_MCP_CAPABILITY_COPY_V1[group.capability]}</p>
              {group.tools.map((tool) => (
                <div className="qrow" key={tool.name}>
                  <span className="mono">{tool.name}</span>
                  <span className="v">{tool.scope}</span>
                </div>
              ))}
            </div>
          ))
        )}

        {model.enabled && groups.length > 0 && (
          <p className="lnote">
            Read live from Base MCP, so a tool Base adds appears here on the next read. Base does
            not operate, endorse or audit the protocols these reach, and Miorail does not either —
            it classifies what each tool is allowed to do here and refuses the rest. Transactions
            are approved in your Base Account and are irreversible.
          </p>
        )}
      </div>
    </div>
  );
}
