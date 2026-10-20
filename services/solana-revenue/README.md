# ArbiVault Native SOL Revenue Service

This isolated service sells a snapshot of **real, eligible opportunity records** from the ArbiVault Supabase `public.opportunities` table. It does not fabricate analytics, trade, withdraw, sweep, or sign transactions.

## Important protocol distinction

The selected asset is native SOL. The Pay Kit `usd(...)` example is not a native-SOL fixed-price charge. This service uses the standard Solana Pay transfer-request flow (`@solana/pay`) for native SOL. Do not describe this implementation as a Pay Kit MPP charge. If native-SOL MPP support is later confirmed and configured by the SDK, it can be evaluated separately.

## Local setup (Penguin Linux)

1. Apply `supabase/migrations/20261020015000_paid_sol_report_revenue.sql` to the intended ArbiVault Shared Backend project only after reviewing it.
2. Copy `.env.example` to `.env` and set the Supabase service-role key, a trusted RPC URL, the independently verified dedicated treasury address, and an integer SOL price in lamports.
3. Install and run:

```bash
cd services/solana-revenue
npm install
cp .env.example .env
# Edit .env with real configuration; never commit it.
npm run dev
```

The service refuses payment operations when configuration is missing or invalid. Do not use a demo recipient or Surfpool RPC for production. Local requests must not be represented as production receipts.

## API

- `GET /health` — reports readiness without returning secret values.
- `POST /invoices` — creates a 15-minute invoice and returns a native SOL Pay URL. It snapshots up to 10 newest records marked `compliance_status = eligible`; if the query fails or returns no records, it refuses to sell a report.
- `POST /verify` — accepts `{ "invoiceId": "...", "signature": "..." }`; checks confirmed on-chain transfer, recipient, exact lamport amount, and reference before atomically marking the invoice paid. An unpaid checkout expires after 15 minutes; if a valid transfer arrives at the expiry boundary, it is still credited rather than silently discarded. A transaction signature can be consumed only once.
- `GET /report/:invoiceId` — returns the snapshot only for a paid invoice.

The report is an opportunity snapshot, not a guarantee of profit or a claim that any opportunity is executable. This initial service does not yet generate arbitrage routes or invoke trading executors.

## Required production controls

- Use a dedicated treasury address; this service never needs the treasury private key.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and RPC credentials server-side.
- Restrict network access and add production rate limiting/WAF as appropriate.
- Confirm the RPC provider's reliability and use a trusted mainnet endpoint.
- Configure Vercel as a separate project with root directory `services/solana-revenue`; do not attach this to the existing failing ArbiVault frontend deployment until reviewed.
- Apply the SQL migration deliberately. This service is not production-ready until a verified treasury, price, production RPC, environment secrets, build, and on-chain validation test are complete.

No payment is accepted from a client-provided signature alone. No transaction is broadcast by this service; customers sign and submit their own transfer.
