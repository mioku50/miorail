import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StillTermsSchema } from '@mioagent/still-engine';

import { McpPublicError } from '../mcp/tools.js';
import { miorailGetStillTermsV1, StillTermsInputV1Schema } from '../mcp/stillTermsTool.js';
import {
  StillCheckWalletInputV1Schema,
  StillCheckWalletOutputV1Schema,
  StillFindSpendInputV1Schema,
  StillFindSpendOutputV1Schema,
  StillSpendProductInputV1Schema,
  StillSpendProductOutputV1Schema,
  StillWhatIfInputV1Schema,
  StillWhatIfOutputV1Schema,
  stillCheckWalletV1,
  stillFindSpendV1,
  stillSpendProductV1,
  stillWhatIfV1,
} from './tools.js';
import { MCP_TOOL_INPUT_ELEMENTS_V1 } from '../mcpLimits.js';
import { STILL_PUBLIC_HOST_V1, STILL_PUBLIC_ORIGIN_V1 } from '../../lib/stillOrigin.js';

// ---------------------------------------------------------------------------
// Still's own MCP server, at /mcp/still: five tools and nothing else.
//
// The Miorail server at /mcp carries eighteen tools about B20 launches and
// stock markets, and by design takes no wallet at all. An assistant asked
// "how much could this wallet borrow without selling?" had one Still tool
// there, the terms, and no way to answer. This server answers it with the
// same check any visitor runs on Still's site (/w/<wallet>), which reads only
// public chain state, under the same per-client limit.
//
// Since 2026-11-02 it also reads what a loan could pay for at Bitrefill, the
// same catalogue as Still's /spend. It reads; it prepares, signs and submits
// nothing. A loan or a purchase is reviewed and approved on Still's site, in
// the owner's own wallet.
//
// Still's signed-in server (/mcp/private) is the one a person adds: it has the
// terms and the Spend reads too, and reads only its own wallet, since no tool
// there takes one. This one reads any wallet, for an assistant that signs in
// nowhere.
// ---------------------------------------------------------------------------

export const STILL_MCP_NAME_V1 = 'still';
/** Moves whenever the tool list moves: a client's cached list has no other key. */
export const STILL_MCP_VERSION_V1 = '1.4.0';
/** Still's own mark, for a host that draws a server's icon (MCP 2025-11-25), on both of Still's servers. */
export const STILL_MCP_IDENTITY_V1 = {
  title: 'Still',
  websiteUrl: STILL_PUBLIC_ORIGIN_V1,
  icons: [
    { src: `${STILL_PUBLIC_ORIGIN_V1}/still-icon.png`, mimeType: 'image/png', sizes: ['1024x1024'] },
    { src: `${STILL_PUBLIC_ORIGIN_V1}/still-favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
  ],
};

export const STILL_MCP_TOOLS_V1 = ['get_still_terms', 'still_check_wallet', 'still_what_if', 'still_find_spend', 'still_spend_product'] as const;

export const STILL_MCP_INSTRUCTIONS_V1 = `Still: spend without selling. Still answers how much a Base wallet could borrow in USDC against its tokenized stocks (Coinbase AAPLc, AMZNc, GOOGLc, METAc, MSFTc, NVDAc, SPCXc, TSLAc), cbBTC, ETH and PAXG (Paxos gold) without selling them, how safe its loans are, and what a price move, more borrowing, a repayment or a deposit would do. Every figure is read from Base at one block by the same engine as Still's own pages.

Still is not a lender. The loans live in Aave V4 (stocks) and Morpho (cbBTC, WETH, PAXG), under the wallet. Still lends at 50% of the protocol's own limit, and at 40% for a stock while Wall Street is closed and around its earnings report. On Aave, a loan that SPCXc covers also pays Aave's risk premium: up to 10% of the rate, which each loan's borrowRateBps already includes. This server only reads: it prepares, signs and sends nothing. A loan is reviewed and approved on Still's site (${STILL_PUBLIC_HOST_V1}), in the owner's own wallet.

Five tools:
1. get_still_terms: the shares and windows in force now. No wallet needed.
2. still_check_wallet: one wallet's report. headline.availableCents is what it could borrow now, in cents of USDC; assets lists each holding; venues lists each loan with safety.marginBps (how far all collateral may fall together before liquidation) and liquidation prices.
3. still_what_if: the same wallet with one to four changes applied together. answer.text is the engine's own answer in words; before and after hold the figures.
4. still_find_spend: what Still could pay for at Bitrefill, with a loan or from the wallet's own USDC, for one country: eSIM data plans, phone top-ups and gift cards.
5. still_spend_product: one of them, with each package's price in USDC and whether Still can pay for it now.

To buy one, the owner connects Still's signed-in server (https://miorail.xyz/mcp/private): miorail_prepare_still_purchase opens the invoice they chose and returns the review of the loan that pays it, and miorail_prepare_still_wallet_purchase opens it to be paid from the USDC already in their wallet, with no loan. Either way their own wallet signs on ${STILL_PUBLIC_HOST_V1}.

Say what a report says at its block and time, and do not repeat its figures later as if current. null means unread, never zero; headline.complete false means "at least". chain_unavailable is our failure, never an empty wallet. Never advise anyone to borrow, buy or sell: Still's limit is not a recommendation. Not offered to US persons. A new loan, purchase or stock buy is prepared only for a person outside the United States: its review checks where the person's own browser connects from and asks them to confirm they are not a US person. Repaying, taking collateral back and selling stay open everywhere, and a US location is never asked to prove anything to get out.`;

export function createStillMcpServerV1(): McpServer {
  const server = new McpServer(
    { name: STILL_MCP_NAME_V1, version: STILL_MCP_VERSION_V1, ...STILL_MCP_IDENTITY_V1 },
    { instructions: STILL_MCP_INSTRUCTIONS_V1, maxToolInputElements: MCP_TOOL_INPUT_ELEMENTS_V1 },
  );
  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });
  const refuse = (error: unknown) => {
    const failure = error instanceof McpPublicError
      ? error
      : new McpPublicError('still_unavailable', 'Still could not answer that right now. This is our failure.');
    return { isError: true as const, content: [{ type: 'text' as const, text: `${failure.code}: ${failure.message}` }] };
  };
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool('get_still_terms', {
    title: 'Still terms, in force now',
    description: 'Still’s versioned terms, with no wallet: the share of each protocol’s limit Still lends at (50%), the closed-market and earnings windows in which a stock counts at 40%, which windows are open now, each stock’s next earnings date, the safety bands, and the two protocols the loans live in. An unread earnings calendar counts every stock at 40%: that is a valid, careful answer, not a failure.',
    inputSchema: StillTermsInputV1Schema,
    outputSchema: StillTermsSchema,
    annotations: READ_ONLY,
  }, async () => {
    try { return reply(await miorailGetStillTermsV1()); }
    catch (error) { return refuse(error); }
  });

  server.registerTool('still_check_wallet', {
    title: 'What a Base wallet could borrow through Still',
    description: `Reads one Base wallet, by 0x address or by Basename or ENS name, the way ${STILL_PUBLIC_HOST_V1}/w/<wallet> does: what it could borrow now without selling (headline.availableCents, cents of USDC, rounded down), each eligible holding with its price and Still’s factor, each existing loan with its debt, safety (marginBps: how far all collateral may fall together before liquidation; state calm, watch, act or liquidation) and liquidation prices, and what could not be read. Public chain state only. Outcomes other than report: invalid_subject, name_not_found, names_unavailable and chain_unavailable; the last two are our failure, never a fact about the wallet.`,
    inputSchema: StillCheckWalletInputV1Schema,
    outputSchema: StillCheckWalletOutputV1Schema,
    annotations: READ_ONLY,
  }, async (args) => {
    try { return reply(await stillCheckWalletV1(args)); }
    catch (error) { return refuse(error); }
  });

  server.registerTool('still_what_if', {
    title: 'What a change would do to a wallet’s Still loans',
    description: 'Applies one to four changes together to one wallet’s current reading and recomputes it with the same engine as the page and the Still Agent: a price moving by a percentage (price), a price going to a dollar figure (price_to), more USDC borrowed on a loan (borrow), USDC paid back or all of it (repay), or tokens pledged from the wallet or bought new (deposit). Loans are "aave-v4" (stocks), "morpho:cbBTC", "morpho:ETH" and "morpho:PAXG" (gold). Returns answer.text, the engine’s answer in words, with its steps and what it holds fixed, and the before and after figures. A refused outcome names why (unread, out_of_range, no_debt, no_collateral, exceeds_liquidity, exceeds_wallet). Nothing is prepared or sent.',
    inputSchema: StillWhatIfInputV1Schema,
    outputSchema: StillWhatIfOutputV1Schema,
    annotations: READ_ONLY,
  }, async (args) => {
    try { return reply(await stillWhatIfV1(args)); }
    catch (error) { return refuse(error); }
  });

  registerStillSpendReadsV1(server);
  return server;
}

/** The Spend reads, here and on Still's signed-in server, under one name
 * and one description: an assistant finds the same tool on either. */
export function registerStillSpendReadsV1(server: McpServer): void {
  const reply = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  });
  const refuse = (error: unknown) => {
    const failure = error instanceof McpPublicError
      ? error
      : new McpPublicError('still_spend_unavailable', 'Still could not read Bitrefill’s catalogue right now. This is our failure.');
    return { isError: true as const, content: [{ type: 'text' as const, text: `${failure.code}: ${failure.message}` }] };
  };
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool('still_find_spend', {
    title: 'What Still could pay for at Bitrefill',
    description: `Searches Bitrefill’s catalogue, the one ${STILL_PUBLIC_HOST_V1}/spend shows, for what Still could pay for in one country, with a loan or from the wallet’s own USDC: eSIM data plans (esim), phone top-ups (refill) or gift cards (giftcard), narrowed by a brand or word. Returns each product’s id, name, the countries it serves and whether Bitrefill has it in stock; read one product with still_spend_product for its packages and prices. checkout.enabled says whether Still pays Bitrefill on this server now. outcome unavailable is Bitrefill’s failure or ours, never an empty catalogue. Cuba, Iran, North Korea and Syria are not offered. It reads only: nothing is bought, reserved or opened.`,
    inputSchema: StillFindSpendInputV1Schema,
    outputSchema: StillFindSpendOutputV1Schema,
    annotations: READ_ONLY,
  }, async (args) => {
    try { return reply(await stillFindSpendV1(args)); }
    catch (error) { return refuse(error); }
  });

  server.registerTool('still_spend_product', {
    title: 'One Bitrefill product, priced in USDC',
    description: 'Reads one Bitrefill product by its id from still_find_spend: each package with its price in USDC as Bitrefill quoted it (prices can move within the hour; a purchase is quoted again), whether it fits Still’s cap of one purchase (withinCap, checkout.capUsdc), and checkout: whether Still can pay for it now, with a loan or from the wallet’s own USDC (available) and, for a phone top-up, the calling code and prefixes the number must start with. prepayment true means Bitrefill sells it only after steps such as a game’s player ID, which it does not offer to Still, so Still cannot buy it. outcome not_found means Bitrefill has no such product; unavailable is Bitrefill’s failure or ours. To buy it, the owner uses miorail_prepare_still_purchase (a loan pays) or miorail_prepare_still_wallet_purchase (the wallet’s own USDC pays) on Still’s signed-in server. It reads only: nothing is bought, reserved or opened.',
    inputSchema: StillSpendProductInputV1Schema,
    outputSchema: StillSpendProductOutputV1Schema,
    annotations: READ_ONLY,
  }, async (args) => {
    try { return reply(await stillSpendProductV1(args)); }
    catch (error) { return refuse(error); }
  });
}
