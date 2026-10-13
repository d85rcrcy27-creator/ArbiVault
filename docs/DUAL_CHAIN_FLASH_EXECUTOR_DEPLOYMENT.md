# Dual-chain flash executor deployment checklist

This deployment adds/configures ArbiVault's BNB Smart Chain and Ethereum mainnet atomic flash executors. The contracts execute two allowlisted DEX swaps and require enough of the borrowed asset to repay Aave plus the configured on-chain minimum profit. An EVM transaction is atomic: a failed leg or failed repayment reverts the transaction, but the caller may still lose gas.

## BNB Smart Chain (chain id 56)

Existing manual deployment workflow: [Deploy ArbiVault BNB Flash Executor](https://github.com/d85rcrcy27-creator/ArbiVault/actions/workflows/deploy-bnb-flash-executor.yml).

The deployment is split into an explicit signer-provisioning step and a separate deploy step. First run [Provision ArbiVault Executor Deployment Signer](https://github.com/d85rcrcy27-creator/ArbiVault/actions/workflows/provision-executor-signers.yml), choose `bnb`, and enter `PROVISION_EXECUTOR_SIGNER`. This generates a dedicated deployment-only private key inside the Supabase Edge Function and stores it directly in Supabase Vault; the raw key is not returned. Fund the returned address with a small amount of native BNB for gas. Then run the BNB deployment workflow below and enter `DEPLOY_TO_BSC_MAINNET`.

The actual deployment private key remains in Supabase Vault and is never present in GitHub Secrets, Actions logs, or repository files. The old shared `Etherum/BSC contract deployment ` secret is retired from the deployment path. Only the non-secret RPC URL `BSC_RPC_URL` is optionally read from GitHub Actions Secrets; otherwise the workflow uses the public BSC dataseed. Both provisioning and deployment are manual-dispatch-only; push events cannot initiate mainnet deployment.

The Supabase deployer validates the repository/workflow identity, fixed chain ID, active BNB trading-hot-wallet record, deployment signer funding, gas reserve, Aave pool code, and constructor configuration before signing and broadcasting. It records the deployment transaction and predicted contract address in `public.flash_executor_deployments`, then verifies runtime bytecode and the immutable `HOT_WALLET()` and `POOL()` getters. The signer/builder read the executor registry and stay fail-closed unless exact source/runtime verification and the payout audit succeed.

## Ethereum mainnet (chain id 1)

Workflow added here: [Deploy ArbiVault Ethereum Flash Executor](https://github.com/d85rcrcy27-creator/ArbiVault/actions/workflows/deploy-ethereum-flash-executor.yml).

Before deployment, run the signer-provisioning workflow above a second time, choose `ethereum`, and enter `PROVISION_EXECUTOR_SIGNER`. It creates a different dedicated key for Ethereum, stores it in Supabase Vault, and returns only the public signer address. Fund that address with native ETH for deployment gas, then run the Ethereum deployment workflow and enter `DEPLOY_TO_ETHEREUM_MAINNET`. No Ethereum deployer private key or payout private key is stored in GitHub. Only the non-secret RPC URL `ETHEREUM_RPC_URL` is optionally read from GitHub Actions Secrets and otherwise falls back to a public Ethereum RPC.

Before broadcasting, the workflow runs Foundry build/tests, requires chain ID 1, and checks Aave V3 Pool, Uniswap V2, SushiSwap V2, WETH, and USDC runtime bytecode. The restricted Supabase signer checks the active Ethereum trading-hot-wallet row and the deployment secret's available gas, then records the deployment and confirms code plus immutable `HOT_WALLET()` and `POOL()` getters. It requires exact Sourcify source/runtime match before the payout audit can unlock signing.

## Before turning either route live

1. Provision one dedicated deployment signer per chain and fund each only for its native-gas requirement. Run the deployment workflows manually with their exact confirmation phrases; neither workflow has a push trigger.
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
