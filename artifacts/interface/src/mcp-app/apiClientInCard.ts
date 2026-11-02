// The card's stand-in for @mioagent/api-client-react, aliased in
// vite.mcp-app.config.ts. The card asks Still through the MCP host
// (stillCardRequestV1) and never fetches the page's API, whose client would
// carry every route's schema into the one file a chat loads.
export async function lendingRequestV1(): Promise<never> {
  throw new Error('authentication_required');
}
