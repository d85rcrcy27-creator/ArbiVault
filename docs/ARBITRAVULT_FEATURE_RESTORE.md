# ArbiVault feature restoration

## Restored

- Persistent `bot_skills` records with conditions, actions, cooldowns, risk limits and backtests.
- Persistent `trades` records for bot execution history.
- Simulated trades are explicitly marked `execution_mode=simulated` and cannot carry a transaction hash.
- On-chain trades have a separate `execution_mode=on_chain` path and require a real `tx_hash` at the database policy layer.
- `bot_wallet_bindings` associates bots with execution/reserve wallets.
- Existing `wallets` and `approved_wallets` are extended rather than duplicated.
- Approved destinations retain a 24-hour activation gate and primary-destination concept.
- WalletCenter exposes hot-wallet inventory and approved destinations from Supabase.

## Custody rule

Private keys must never be returned to the Vite client or stored in `public.wallets`. A production hot-wallet generator/signing service should use a dedicated server-side signer/HSM or isolated secret-management service. The browser only receives public addresses and transaction status/hashes.

## Transaction hashes

The UI no longer invents `0x...` hashes for simulated executions. A transaction hash is displayed only when `tx_hash` exists on a trade with `execution_mode=on_chain`.
