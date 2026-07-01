import { Router } from 'express';
import { PortfolioResponseSchema } from '@mioagent/api-zod';
import { getTokenBalancesProviderFromEnv } from '@mioagent/data-providers';

export const portfolioRouter = Router();

portfolioRouter.get('/', async (req, res, next) => {
  try {
    const address = (req.query.address as string) || (req as { session?: { user?: { address?: string } } }).session?.user?.address;

    if (!address) {
      return res.status(400).json({ error: 'Wallet address not configured' });
    }

    const chainEnv = process.env.CHAIN_ENV || 'sepolia';
    const chainId = chainEnv === 'sepolia' ? 84532 : 8453;
    let balanceFormatted = '0.0000';
    let balance = '0';

    let rpcStatus: "connected" | "missing" | "failed" = "connected";
    const rpcUrl = chainEnv === 'sepolia' ? process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org' : process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';

    try {
      const fetchRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBalance',
          params: [address, 'latest']
        })
      });
      const data = await fetchRes.json();
      if (!data.error && data.result) {
        balance = BigInt(data.result).toString();
        balanceFormatted = (Number(balance) / 1e18).toFixed(4);
      } else {
        rpcStatus = "failed";
      }
    } catch {
      rpcStatus = "failed";
    }

    const tokens: Array<{
      symbol: string;
      name?: string;
      address: string;
      balance: string;
      balanceFormatted: string;
      decimals?: number;
      usdValue?: string;
      logoUrl?: string;
      verified?: boolean;
      possibleSpam?: boolean;
    }> = [
      {
        symbol: 'ETH',
        name: 'Ethereum',
        address: 'native',
        balance,
        balanceFormatted,
        usdValue: '0.00',
        verified: true,
        possibleSpam: false,
      }
    ];

    const { provider, status, providerName } = getTokenBalancesProviderFromEnv();
    let providerStatus = status;
    let tokenBalancesStatus: "connected" | "missing" | "failed" = providerName === "none" ? "missing" : "connected";

    if (provider && providerName !== 'none') {
      try {
        const erc20Balances = await provider.getTokenBalances({ address, chainId });
        for (const tb of erc20Balances) {
          tokens.push({
            symbol: tb.symbol,
            name: tb.name || tb.symbol,
            address: tb.address,
            balance: tb.balance,
            balanceFormatted: tb.balanceFormatted,
            decimals: tb.decimals,
            usdValue: tb.usdValue || '0.00',
            logoUrl: tb.logoUrl,
            verified: tb.verified,
            possibleSpam: tb.possibleSpam,
          });
        }
        if (tokens.length === 1 && (providerName === 'moralis' || providerName === 'alchemy')) {
          providerStatus = 'No ERC-20 tokens found for this wallet';
        }
      } catch {
        providerStatus = 'Token balances provider failed. Showing native ETH only.';
        tokenBalancesStatus = 'failed';
      }
    }

    let totalUsd = 0;
    for (const t of tokens) {
      if (t.usdValue && !isNaN(Number(t.usdValue))) {
        totalUsd += Number(t.usdValue);
      }
    }

    const pricesStatus: "connected" | "missing" | "failed" = process.env.COINGECKO_API_KEY || process.env.PRICE_PROVIDER ? "connected" : "missing";
    const riskStatus: "connected" | "missing" | "failed" = process.env.GOPLUS_API_KEY || process.env.RISK_PROVIDER ? "connected" : "missing";

    res.json(PortfolioResponseSchema.parse({
      totalUsdValue: totalUsd.toFixed(2),
      tokens,
      updatedAt: new Date().toISOString(),
      providerStatus,
      providers: {
        rpc: rpcStatus,
        tokenBalances: tokenBalancesStatus,
        tokenBalancesProvider: providerName,
        prices: pricesStatus,
        risk: riskStatus,
      }
    }));

  } catch (error) {
    next(error);
  }
});

