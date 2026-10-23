# Jupiter Lend Flashloan Preflight

## Status

This is an isolated **simulation-only** Edge Function. It does not enable or register a trading route, create an execution attempt or signing request, return a signable transaction, sign, or broadcast. The existing Solana swap-only routes and the Ethereum/BNB flash routes remain unchanged.

The function composes this transaction shape for the USDC/SOL/USDC round trip:

1. Required token-account setup
2. Jupiter Lend flash borrow
3. Jupiter Swap V2 USDC → wrapped SOL
4. Jupiter Swap V2 wrapped SOL → USDC
5. Jupiter Lend payback
6. Token-account cleanup

Borrow, both swaps, and payback are simulated as a single Solana transaction. A failure in any instruction makes the simulation fail. Net-profit screening subtracts the Jupiter Lend fee and estimated network fee, and uses the second swap's minimum output for the conservative return estimate.

## Required configuration

Configure these as Supabase Edge Function secrets; never paste their values into chat or commit them:

- `JUPITER_API_KEY` — required by the Jupiter Swap API V2 build endpoint.
- `SOLANA_RPC_URL` — recommended to be a reliable Solana mainnet RPC. If omitted, the public Solana mainnet endpoint is used for this preflight.

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Edge runtime. The function does not use Turnkey or any wallet private key.

## Endpoint

After the branch is reviewed and the function is deployed through the project's normal deployment procedure:

- `POST /functions/v1/arbivault-jupiter-flashloan`
- Diagnostic request: `{"mode":"diagnostic"}`
- Simulation request: `{"mode":"simulate","source_wallet_id":"<your-signed-in-user's-active-Solana-trading-wallet-id>","amount_raw":"10000000","slippage_bps":50}`

Use a normal Supabase user access token in the Authorization bearer header. The source wallet must belong to that user and be an active Solana trading hot wallet. Do not send the internal cron token to a browser or user-facing client.

The default simulation size is 10 USDC. The supported range is 1–100 USDC, and each swap is capped at 30 bps (0.30%) slippage. The fixed route uses canonical USDC and wrapped-SOL mints only.

## Limitations and required validation

- A successful simulation is not a guarantee of future execution or profit.
- Current quotes are sequential and can change between instructions being built and a transaction later being submitted.
- The strategy bot does not yet call this function and there is no enabled Solana flash-liquidity route.
- The Solana signer must have a narrow, explicit program/instruction allowlist for Jupiter Lend + the required swap programs before any signing workflow can use these instructions.
- Do not set `ready_for_signing` true or enable automatic execution on the basis of this preflight alone.
- A real confirmation and balance-delta reconciliation is required to claim a trade or realized profit.

## Review checklist

- [ ] GitHub Deno type-check passes for this Edge Function.
- [ ] `diagnostic` confirms mainnet RPC and Jupiter API configuration.
- [ ] A 10 USDC test simulation succeeds with zero transaction signatures or broadcasts.
- [ ] Negative simulations are verified for failed/mismatched API quotes, non-positive net output after fees, unknown lookup tables, inactive wallet, non-owned wallet, and amounts outside the allowed range.
- [ ] Review accepts that this preflight uses Jupiter's quoted output and minimum-output threshold rather than a separate price-impact field (not guaranteed by the documented /build response).
- [ ] Security review approves the instruction/ALT boundary before signer integration.
- [ ] UI and bot route integration is implemented separately, with execution still disabled until independently approved.
