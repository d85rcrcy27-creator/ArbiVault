# ArbiVault Flash Executor

This contract is a candidate implementation, not a live deployment.

## Security properties

- A single immutable ArbiVault hot wallet is both the transaction initiator and profit recipient.
- The Aave V3 Pool address, loan asset, token allowlist, and router allowlist are fixed at deployment.
- The executor is not upgradeable and has no owner withdrawal or arbitrary-call function.
- It accepts only canonical `swapExactTokensForTokens` calls to constructor-allowlisted routers.
- Each swap must return tokens to the executor; paths must start with the current asset and only use constructor-allowlisted tokens.
- The last route leg must return the borrowed asset.
- The flash-loan callback validates Aave Pool sender and initiator, checks actual balance deltas, requires amount + premium + requested minimum profit, pays the realized excess to the immutable hot wallet, and approves only the exact repayment amount.
- Reverts are atomic: if any swap, minimum output, repayment, or profit assertion fails, no payout persists and the flash loan reverts.

## Supported route-call ABI

For each leg, `targets[i]` is an allowlisted V2-style router, `values[i]` must be zero, and `data[i]` must be canonical ABI encoding of:

```solidity
swapExactTokensForTokens(
  uint256 amountIn,
  uint256 amountOutMin,
  address[] path,
  address to,
  uint256 deadline
)
```

`to` must equal the executor contract. Route amounts are sequential: each subsequent leg must spend the actual output amount of the previous leg. Use short deadlines and nonzero output minimums from current quotes.

## Validation

Run `forge test -vvv`. Tests use mocked Aave, ERC-20 tokens, and routers. They verify repayment, profit payout, baseline preservation, caller authorization, router allowlisting, recipient pinning, minimum-profit enforcement, and final-asset validation. Passing tests does not verify a production deployment.

## Required before any live deployment

1. Deploy a chain-specific instance only after reviewing and independently auditing this source.
2. Initialize with the exact active ArbiVault-generated `trading_hot` wallet address as `hotWallet`, the correct chain-specific Aave V3 Pool, the intended loan asset, and reviewed router/token allowlists for that chain. Deploy a separate executor for each chain and generated hot wallet. The executor's `HOT_WALLET()` getter must match the selected source wallet address byte-for-byte (case-insensitive for EVM addresses).
3. Verify deployed source and runtime bytecode (including constructor arguments) using Sourcify or the chain explorer.
4. Record the deployment address, chain, bytecode hash, constructor configuration, and immutable hot-wallet recipient in ArbiVault.
5. Run a non-broadcast `eth_call` preflight with a real quote path, then get the existing transaction approval/passkey flow for any actual broadcast.
6. Verify the receipt status, Aave premium repayment, and `FlashLoanSettled` event. Confirm the hot wallet's token balance increase matches emitted `profit`. Do not mark the payout verified solely because this unit test passes.
