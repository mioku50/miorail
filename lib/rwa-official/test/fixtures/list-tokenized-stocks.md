<!-- Excerpt of https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks.md,
     fetched 2026-09-12. The successor to tokenized-stocks-on-base.md: Base moved the
     page, renamed the heading to `## Contract Addresses`, and dropped COINc, CRCLc and
     INTCc. The two tables the parser reads, and the prose between them, kept verbatim
     so a change in the document's shape breaks a test here rather than in production. -->

**Chainlink data feeds on Base.** Read each via `latestRoundData()` on the proxy address below. All feeds return 8 decimals, cover US equities (24/5 market hours), and update on a 0.5% price deviation or a 24-hour heartbeat. Values are total-return; apply the pause and staleness handling above.

| Feed           | Address                                      |
| -------------- | -------------------------------------------- |
| Coinbase AAPL  | `0x787f13dEa48Db0897CbCDD985de77809D837F988` |
| Coinbase AMZN  | `0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295` |
| Coinbase GOOGL | `0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2` |
| Coinbase META  | `0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D` |
| Coinbase MSFT  | `0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c` |
| Coinbase MSTR  | `0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a` |
| Coinbase NVDA  | `0x04689a41629776563E6822F76f2e57D148d28513` |
| Coinbase SNDK  | `0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA` |
| Coinbase SPCX  | `0x6A634B235903C4ad6376892180d6fF8612e3Fa68` |
| Coinbase TSLA  | `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4` |

### Offchain

Offchain price data can be sourced from providers such as CoinGecko, CoinMarketCap, or RWA. These aggregators track the token's live market price from the DEXs where the B20 trades, which runs 24/7 whenever the secondary market is active.

Two common patterns are used to determine value:

* Directly reading the token's market price from a provider that tracks the B20 asset.
* Reading the underlying reference price and applying the multiplier calculation manually.

### Historical Data

For historical OHLC and time-series data, use market-data providers or query Chainlink round history by `roundId`.

Since prices are total-return (multiplier-adjusted), reconstruct the series consistently by applying the multiplier history ([`MultiplierUpdated`](/specifications/b20/reference/interfaces/ib20-asset) events, emitted by both scheduled and instant multiplier changes) if starting from raw share prices.

## Contract Addresses

| Ticker           | Contract address                             |
| ---------------- | -------------------------------------------- |
| Onchain Registry | `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD` |
| AAPLc            | `0xb200000000000000000000C2e324d24d7eEcd1fb` |
| AMZNc            | `0xb200000000000000000000d9192b6B456483C2E8` |
| GOOGLc           | `0xb2000000000000000000002D0BA3164cc74f58B7` |
| METAc            | `0xb2000000000000000000008bC8786B856E61707C` |
| MSFTc            | `0xB200000000000000000000Ab99cFa739E253872B` |
| MSTRc            | `0xb2000000000000000000004884b426556b92883d` |
| NVDAc            | `0xb20000000000000000000078ee7ce2fE4908108C` |
| SNDKc            | `0xb200000000000000000000397293Cb8cda9a10c5` |
| SPCXc            | `0xb2000000000000000000007b9fcbd005511aCBd5` |
| TSLAc            | `0xb2000000000000000000001e800a7f5189430cD0` |
