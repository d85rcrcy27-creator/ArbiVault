# AGENTS.md

## Project Context

ArbiVault is a Vite + React 18 frontend deployed to Vercel. Authentication is Supabase Auth, persistence is Supabase PostgreSQL, payments use the configured payment providers, and server-side automation runs through Supabase Edge Functions/database jobs. Browser code must never contain wallet private keys, signing secrets, service-role credentials, or other custody secrets.

## Local Development

- Run `pnpm install` and `pnpm dev` for local development.
- Vercel builds with `pnpm install --frozen-lockfile` followed by `pnpm build` according to `vercel.json`.
- `vite.config.js` provides the Vite development server configuration.

## Environment

- Client-visible configuration uses only `VITE_*` values that are safe to expose to the browser, such as the Supabase project URL and anon/public key.
- Private credentials, service-role credentials, blockchain RPC secrets, payment secrets, wallet private keys, signing material, and internal bot credentials must never be committed to Git or exposed through `VITE_*` variables.
- Wallet private keys are custody secrets. Store them in Supabase Vault or an equivalent server-side secret manager and access them only from trusted server-side signing code.
- The browser may request a signing operation, but must never receive the private key. Server-side signing must validate authenticated ownership, wallet status, approved destination rules, transaction limits, and audit logging before signing.

## Wallet Security

- Store public wallet addresses and non-sensitive metadata in PostgreSQL.
- Store hot-wallet private keys only in protected server-side secret storage.
- Never place private keys in React state, localStorage, sessionStorage, IndexedDB, URL parameters, logs, source maps, build artifacts, Git history, or client-side environment variables.
- Do not return private keys from Supabase RPCs or Edge Functions to the browser.
- Use narrowly scoped service-role access for secret retrieval/signing and audit every custody operation.
- Approved withdrawal destinations use the activation-delay and primary-destination controls in the database.

## Bot Architecture

ArbiVault has three distinct bot roles:

1. Execution Bot — evaluates opportunities, applies bot skills/risk limits, and records real or simulated trades. A real on-chain trade must have a transaction hash supplied by the signing/broadcast layer; hashes must never be fabricated.
2. Sync Bot — reconciles wallet balances, transaction confirmations, market/reference data, and reconciliation state.
3. Payment Processing Bot — processes payment requests, confirmations, expirations, and payment-to-wallet reconciliation separately from trading.

Bot workers run server-side. The UI is a control and monitoring surface, not the trusted execution environment.

## Build

- `pnpm build` must succeed for Vercel deployment.
- The lockfile must stay synchronized with `package.json`; after dependency changes regenerate `pnpm-lock.yaml` before using frozen installs.
- Keep Vercel-compatible Vite/Rollup configuration; do not reintroduce platform-specific development tooling into production builds.

## Verification

Before merging changes:

- Search the repository for obsolete migration/runtime references and remove them.
- Confirm no secrets or private keys are present in source, environment templates, logs, generated bundles, or documentation.
- Verify Supabase RLS policies and server-side functions before changing wallet or payment behavior.
- Run the Vercel-compatible build and lint/type checks available in the repository.
- Verify bot jobs, wallet custody boundaries, payment processing, and transaction-hash handling in a non-production environment before enabling real execution.
