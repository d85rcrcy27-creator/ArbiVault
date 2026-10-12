# ArbiVault AI strategy proposals and review gates

## Scope

The Strategy Review panel generates structured, high-level proposals for:

- DEX arbitrage
- Collateral swaps
- Liquidations
- Debt refinancing

Every proposal is saved with `status = pending_review`. The AI output is not transaction calldata and is never passed to a signer. A human may reject a proposal or approve it for *preflight review only*.

## Secret configuration

Add `OPENAI_API_KEY` as a Supabase Edge Function secret in the Supabase dashboard:

`https://supabase.com/dashboard/project/karbtrfzxfyipxkhhqjz/functions/secrets`

Optional: `OPENAI_MODEL` (defaults to `gpt-4o-mini`). Keep both server-side; neither belongs in a `VITE_*` variable or client bundle.

## Migration and function

After review/merge, apply the SQL migration:

`supabase/migrations/20261012070000_add_ai_strategy_proposals.sql`

Deploy the authenticated function:

`supabase functions deploy arbivault-strategy-proposals`

The function must keep JWT verification enabled. It checks the signed-in user again, uses a server-side service role only inside the Edge Function, limits proposal generation to ten requests per account per hour, and applies server-side risk caps to model output.

## Review state machine

`pending_review → approved_for_preflight` or `pending_review → rejected`.

Approval does not register a strategy on-chain, create or enable a bot, sign a transaction, or broadcast funds. The status is deliberately not named `live` or `deployed`.

## Builder / simulator / signer / executor

ArbiVault's existing flash-liquidity pipeline remains its separate, chain-specific execution route. This addition does not expand the deployed executor allowlists. Each proposal category must receive an audited adapter, allowlisted chain/protocol addresses and selectors, a transaction builder, an `eth_call` simulation that checks the full state transition and net economics, and signer policy verification before that category can become eligible for preflight or execution. Unsupported categories remain `blocked_pending_adapters`.

Do not copy the generic arbitrary-target executor example directly into production. Call allowlists, token/asset constraints, balance-delta accounting, repayment, min-profit, destination routing, and token-transfer return values all require validation inside the contract, not just in the proposal generator.

## Verified profitability and "proven"

The migration creates a service-written `strategy_proposal_runs` table and a database roll-up. A proposal becomes `proven` only after at least five distinct chain/transaction records are confirmed and show positive profit based on a verified asset-balance delta. Estimated model output, quote differences, backtest results and transaction receipt success alone never qualify as proof.

Only trusted backend services may write result rows. The current proposal feature does not yet populate these rows because no proposal-category execution adapters are attached to the confirmation service. Until that integration is implemented and tested, proposal proof counts remain zero and nothing is marked proven automatically.
