# ArbiVault Arbitrum Yield Aggregator

## Scope
Discovery and comparison for DeFi yield opportunities on Arbitrum One. Initial data source: DefiLlama Yields API. This is not a vault, investment adviser, smart-contract audit, or execution authorization.

## Data contract
Each observation includes provider pool ID, protocol label, asset symbol, TVL, headline/base/reward APY, stablecoin flag, exposure label, source, and observation time. Do not present an opportunity as current if the observation is older than 30 minutes. Do not substitute mock data when the provider fails; show a data-unavailable state and preserve the last observation only with an explicit stale label.

## Ranking
1. Exclude malformed rows and rows without a provider pool ID, protocol, TVL, or APY.
2. Show gross APY separately from base and reward APY.
3. Compute net estimated yield only when the user supplies a deposit amount and explicit annualized gas/protocol cost assumptions or a trusted quote source supplies them.
4. Never label gross APY as guaranteed, and never treat provider risk labels as an audit.
5. Surface liquidity/TVL, reward-token exposure, stablecoin status, source timestamp, withdrawal constraints, and contract-risk review status alongside APY.

## Execution and custody
Discovery is read-only. This module must not sign, broadcast, approve token allowances, deposit, withdraw, or move funds. Any later execution integration must go through existing ArbiVault server-side authorization and signing controls, enforce chain/token/protocol allowlists, simulate first, re-quote before signing, apply slippage and transaction limits, and record the real transaction hash returned by the broadcast layer. Never fabricate a hash or success status.

## Next integration steps
- Add a dedicated Yield Aggregator route/panel to the existing React app.
- Prefer a rate-limited server-side Supabase Edge Function proxy/cache over frequent browser polling.
- Add a Supabase table for persisted provider observations only after confirming retention and access requirements; enable RLS and do not expose privileged credentials.
- Add provider freshness, schema, timeout, rate-limit, and empty-response tests.
- Connect to the atomic builder only after protocol addresses, chain ID 42161, token addresses, ABI, route simulation, and authorization checks are verified.
- Deploy through the existing Vercel Git integration after CI passes and review is approved.
