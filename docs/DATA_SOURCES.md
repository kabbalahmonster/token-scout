# Free data sources

| Source | Use | Public budget used by DoomScout | Failure meaning |
| --- | --- | --- | --- |
| GeckoTerminal | paginated top/new pool discovery and hourly OHLCV bootstrap | ≤25 rpm, shared queue | broad discovery/history is partial, stale, or unavailable |
| DexScreener | profile leads, pair cross-checks, price, liquidity, volume | profiles ≤50 rpm; pairs ≤240 rpm | pair evidence is stale or unavailable |
| Robinhood RPC | code, storage, ERC-20 reads, gas | ≤240 rpm | contract facts are unknown |
| Robinhood Blockscout | optional verification context | ≤50 rpm, 5-minute cache | verification context is unknown |
| CoinGecko | ETH/USD reference | ≤20 rpm, 5-minute cache | analysis continues in ETH terms |
| Sushi | read-only exact-input quote | ≤30 rpm | route is unverified, timed out, or failed |

The configured public Robinhood mainnet RPC is
`https://rpc.mainnet.chain.robinhood.com`; chain ID is 4663 and native gas is
ETH. Provider payloads are untrusted. Bounded raw pair evidence is stored for
diagnostics, while normalized immutable snapshots are analytics truth.

Default automated intake reads five top-pool pages and two new-pool pages every
15 minutes. A lead enters the candidate universe when its indexed pool has at
least $1,000 liquidity, $100 in 24-hour volume, and two 24-hour transactions.
All three thresholds and both page counts are configurable. Observations below
the gate remain in the discovery ledger and can qualify on a later poll.

The first assessment of an eligible pool imports 168 hourly OHLCV candles.
These are real provider candles tagged `geckoterminal_1h_candle`; they are not
fabricated from provider percentage-change fields. Live snapshots then extend
the series, while normal retention/aggregation keeps older evidence compact.

Adapter state is visible at `/operations` and `/api/v1/sources/status`.
Unavailable values remain `null`; provider failure never becomes zero.
