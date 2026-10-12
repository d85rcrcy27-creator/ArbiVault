# Dual-chain flash executor deployment checklist

This deployment adds/configures ArbiVault's BNB Smart Chain and Ethereum mainnet atomic flash executors. The contracts execute two allowlisted DEX swaps and require enough of the borrowed asset to repay Aave plus the configured on-chain minimum profit. An EVM transaction is atomic: a failed leg or failed repayment reverts the transaction, but the caller may still lose gas.

## BNB Smart Chain (chain id 56)

Existing manual deployment workflow: [Deploy ArbiVault BNB Flash Executor](https://github.com/d85rcrcy27-creator/ArbiVault/actions/workflows/deploy-bnb-flash-executor.yml).

Required GitHub repository Actions secrets:
- `BSC_DEPLOYER_PRIVATE_KEY`: dedicated funded deployment key; never a trading hot-wallet private key.
- `BSC_RPC_URL`: BSC mainnet RPC (optional in the workflow, which falls back to the public BSC dataseed).

The current workflow pins the intended BNB hot-wallet payout address and refuses to continue unless chain id 56, deployment signer funding, bytecode, and the immutable `HOT_WALLET()` getter check pass. After source verification, the resulting address still must be configured in Supabase.

## Ethereum mainnet (chain id 1)

Workflow added here: [Deploy ArbiVault Ethereum Flash Executor](https://github.com/d85rcrcy27-creator/ArbiVault/actions/workflows/deploy-ethereum-flash-executor.yml).

Required GitHub repository Actions secrets:
- `ETHEREUM_DEPLOYER_PRIVATE_KEY`: dedicated funded deployment key; never reuse the trading hot-wallet private key.
- `ETHEREUM_HOT_WALLET`: exact active ArbiVault-generated Ethereum trading hot wallet to receive profit.
- `ETHEREUM_RPC_URL`: Ethereum mainnet RPC URL. If omitted, the workflow uses a public RPC fallback.

Before broadcasting the deployment, run the Foundry build/tests, require exact chain id 1, validate the hot-wallet address and check deployed bytecode exists at Aave V3 Pool, Uniswap V2, SushiSwap V2, WETH and USDC. After deploy, the workflow checks deployed bytecode and immutable `HOT_WALLET()` and `POOL()` getters. It attempts Sourcify source verification but does not declare that verification successful unless the verifier confirms it.

## Before turning either route live

1. Run the manual deployment workflow only after the required GitHub Secrets are populated and the payout wallet has been compared against the active generated hot wallet in ArbiVault.
2. Record contract deployment transaction and address from the Actions summary.
3. Verify contract source and runtime bytecode on the relevant explorer/Sourcify; repeat the app's on-chain diagnostic and confirm the immutable `HOT_WALLET()` matches the intended active ArbiVault wallet.
4. Add `ARBIVAULT_BSC_FLASH_EXECUTOR` and `ARBIVAULT_ETH_FLASH_EXECUTOR` in the Supabase Edge Function secrets screen. Do not set `ARBIVAULT_BSC_FLASH_EXECUTOR_PAYOUT_AUDITED=true` or `ARBIVAULT_ETH_FLASH_EXECUTOR_PAYOUT_AUDITED=true` until the source and payout controls have been independently checked.
5. Deploy the reviewed builder, strategy worker and signer updates with JWT/cron-token protections preserved. Keep the Ethereum strategy route disabled until its quote builder, signer allowlist and executor diagnostic all pass.
6. Run a read-only quote and simulation first. A positive cross-DEX spread is not proof of a profitable on-chain trade. Only run an explicitly authorized, bounded mainnet transaction after gas, premium, slippage, balances and min-profit checks pass.

## Ethereum route change

The previous Ethereum executor only allowed Uniswap V2 for both swap legs; that cannot represent a price difference across two distinct venues. This branch changes its allowlist to Uniswap V2 and SushiSwap V2 and requires the two transaction legs to use distinct routers. The transaction builder and signer allowlist are updated consistently. Sources for the router addresses: [Uniswap V2 deployment documentation](https://developers.uniswap.org/docs/protocols/v2/deployments) and the [SushiSwap V2 contracts repository](https://github.com/levx-me/sushiswap-core).

## Limits

- Deployment is not the same as payout verification or live trading authorization.
- This is a two-router V2 route only; it is not a general-purpose arbitrary-target executor.
- The gas estimate is conservative but not a guarantee. A failed transaction can still consume gas.
- No executor deployment or live transaction should be claimed until an on-chain deployment transaction/receipt and independent post-deployment checks exist.
