# ArbiVault custody and signing readiness

Status: maintenance-branch design and verification notes. This document does not authorize production wallet changes or live transactions.

## Custody decision

- Keep existing wallet records, addresses, balances, and secrets unchanged while verification is in progress. Never export private keys.
- Prefer Turnkey-managed keys for automated trading where the exact existing wallet address can be verified as a Turnkey wallet account and the policy is configured for that chain and action.
- Use Safe for EVM treasury and administrative control, not as a universal wallet replacement. Safe smart accounts are chain-specific and do not replace Bitcoin or Solana custody.
- Keep deployment authority separate from trading signers. Withdrawal and treasury permissions must not be inherited by automated trading adapters.
- Do not change a wallet's `custody_type` or an adapter's `signer_provider` merely to make the UI look configured. The signing service must prove the configured provider controls the exact address.

## Current code support and required adapter policies

| Chain | Network identity | Current signing implementation | Required guardrails |
|---|---|---|---|
| Ethereum | chain ID 1 | Internal-vault EVM signing | Exact sender/address match; chain ID 1; allowlisted router/executor; audited executor payout; verified + approved wallet; strategy binding |
| BNB Smart Chain | chain ID 56 | Internal-vault EVM signing | Exact sender/address match; chain ID 56; allowlisted PancakeSwap V2/Biswap V2 or audited executor; verified + approved wallet; strategy binding |
| Solana | Mainnet genesis hash | Turnkey signer path only | Turnkey wallet must match exact fee payer/signer address; explicit non-empty program allowlist; resolve/validate address lookup tables; verified + approved wallet; strategy binding |
| Bitcoin | Bitcoin mainnet | Internal-vault PSBT signing | Mainnet address/key match; validate each PSBT input against wallet-owned UTXOs; reject unsupported scripts; verified + approved wallet; explicit withdrawal approval |

Turnkey EVM and Turnkey Bitcoin signing are **not implemented by this maintenance branch**. Do not switch those adapters to Turnkey until their signer implementations, account/address lookup, signature verification, and no-broadcast integration tests are added and pass.

## Protocol allowlists

- Ethereum: Uniswap V2 Router02 at `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`; only add other routers after chain-specific live code/address verification.
- BNB Smart Chain: PancakeSwap V2 Router at `0x10ED43C718714eb63d5aA57B78B54704E256024E`; Biswap V2 must be verified against current official protocol records before being enabled.
- Solana Jupiter Lend flashloan mainnet program: `jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS`. This single program ID is not sufficient by itself; the transaction may include compute-budget, token, associated-token, Jupiter swap, and lookup-table-related instructions. Allowlist only the exact instruction programs required by a reviewed transaction template.
- Bitcoin is UTXO/PSBT signing, not a DEX-router adapter. The adapter catalog should describe the protocol family accurately even though the signing boundary remains separate.

## Bot wallet binding requirements

- Strategy execution must resolve the wallet through `arbivault_strategy_wallets` using the exact owner, strategy bot, chain, wallet ID, purpose `strategy_execution`, and assigned status.
- Legacy bot execution must resolve through `bot_wallet_bindings` using the exact owner, bot configuration, and execution role.
- Both paths additionally require an active trading-hot wallet, verified provenance, and an owner-scoped `approved_wallets.status='approved'` record.
- The signer independently verifies the strategy binding and execution-attempt payload hash. A missing or ambiguous binding blocks signing.

## Current release blockers observed in Supabase

- The primary execution policy is enabled in `live` mode.
- All four configured broadcast-capable adapters are internal-vault adapters, and their latest wallet approval records are not approved.
- Current wallet metadata shows no approved, verified active trading wallet for these adapters.
- The configured Solana adapter does not currently satisfy the new Turnkey-provider and explicit program-allowlist requirements.
- The executor deployment registry has no entries, so Ethereum/BNB flash-loan executor readiness cannot be asserted.
- Leaked-password protection remains disabled in Supabase Auth. Three strategy RPCs are being changed to SECURITY INVOKER in the accompanying migration; that migration is not applied by this branch.

Do not enable or promote live execution until these records are reconciled and the branch CI, dependency audit, Supabase security advisors, and chain-specific read-only signing checks pass.
