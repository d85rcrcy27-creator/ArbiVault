# Turnkey-only profit payout security gate

Status: proposed guardrail patch on `security/turnkey-profit-payout-guardrails`. This is not a deployment or proof that Turnkey signing is implemented.

## Findings confirmed from current source

1. **High — payout destination custody mismatch.** The profit-recipient function previously generated a random EVM private key, stored it through Supabase Vault, and marked the resulting wallet/profile active. That is not a Turnkey-managed wallet and conflicts with the requested 100% Turnkey payout policy.
2. **High — executor deploy preflight accepted non-Turnkey recipients.** The configuration resolver validated role, status, address, and secret reference but did not require Turnkey custody.
3. **High — signer-side payout revalidation accepted non-Turnkey recipients.** The signer rechecked chain, role, status, and address but did not enforce Turnkey custody.
4. **High — integration gap.** Existing custody-readiness documentation says Turnkey EVM signing is not implemented. Changing wallet metadata alone cannot prove Turnkey controls an address.

## Patch on this branch

- Disable creation of new server-vault profit wallets through the recipient endpoint. It returns HTTP 409 until a Turnkey wallet lookup and signer-control verification path exists.
- Disable recipient activation through that endpoint until Turnkey identity, chain, and signing control can be verified without exporting private keys.
- Require `wallets.custody_type = 'turnkey'` in executor deployment preflight and signer-side payout revalidation.
- Existing wallet records and keys are not modified. Existing server-vault recipients will fail the new execution checks. This is intentional fail-closed behavior.

## Verification required before merge/deploy

- Implement Turnkey EVM address/account lookup and the signing adapter; verify exact chain-specific wallet address and signature recovery.
- Confirm the database schema supports `custody_type='turnkey'` and stores a durable Turnkey account/wallet reference. Do not add fake metadata to legacy wallets.
- Add tests for wrong owner, wrong chain, wrong Turnkey address, missing Turnkey account ID, legacy server-vault recipient, revoked recipient, duplicate active recipients, and signer failure.
- Run Supabase function checks, Foundry tests, `pnpm typecheck`, `pnpm lint`, dependency audit, build, Supabase RLS/security advisor checks, and read-only production registry reconciliation.
- Keep flash-loan routes disabled until deployed bytecode, immutable payout recipient, signer policy, and payout balance-delta proof are independently verified.

No wallet transfers, signing requests, contract deployments, or production database changes are performed by this patch.
