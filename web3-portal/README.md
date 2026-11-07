# ArbiVault Web3 Portal

A separately deployable customer-facing frontend isolated from the existing ArbiVault operator and trading application.

## Current scope
- Responsive customer-facing portal shell.
- Explicit preview state; no balances, customer records, trades or revenue are fabricated.
- Wallet connection, authentication, customer ledger, route quoting and transaction execution are not wired.
- No private keys, signing material, service-role credentials or RPC secrets are used in browser code.

## Security boundaries
- Never provide custody secrets or service-role credentials to this frontend.
- Future customer data must use authenticated, owner-scoped server APIs and Supabase RLS.
- Wallet connection must be read-only initially. Signing and broadcasting require a separate reviewed execution service, risk policy, explicit customer confirmation and audit evidence.
- Atomic Builder integration remains read-only until contract review, fork tests, invariant tests, independent audit and testnet verification are complete.
- Never present strategy scans, simulations or blocked attempts as confirmed transactions or realized revenue.

## Separate Vercel deployment
Create a separate Vercel project linked to this repository with Root Directory set to web3-portal, Framework Preset Vite, Build Command npm run build and Output Directory dist. Keep preview deployments separate from the existing operator application until authentication, data isolation and security reviews pass.
