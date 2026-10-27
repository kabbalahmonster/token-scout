# Free data sources

| Source | Use | Public budget used by DoomScout | Failure meaning |
| --- | --- | --- | --- |
| DexScreener | profiles, pairs, price, liquidity, volume | profiles ≤50 rpm; pairs ≤240 rpm | discovery/market evidence is stale or unavailable |
| Robinhood RPC | code, storage, ERC-20 reads, gas | ≤240 rpm | contract facts are unknown |
| Robinhood Blockscout | optional verification context | ≤50 rpm, 5-minute cache | verification context is unknown |
| CoinGecko | ETH/USD reference | ≤20 rpm, 5-minute cache | analysis continues in ETH terms |
| Sushi | read-only exact-input quote | ≤30 rpm | route is unverified, timed out, or failed |

The configured public Robinhood mainnet RPC is
`https://rpc.mainnet.chain.robinhood.com`; chain ID is 4663 and native gas is
ETH. Provider payloads are untrusted. Bounded raw pair evidence is stored for
diagnostics, while normalized immutable snapshots are analytics truth.

Adapter state is visible at `/operations` and `/api/v1/sources/status`.
Unavailable values remain `null`; provider failure never becomes zero.
