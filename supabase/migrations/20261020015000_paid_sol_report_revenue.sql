-- Native SOL paid-report ledger. No client-side access; the server service-role client is the only writer.
create table if not exists public.paid_report_invoices (
  id uuid primary key,
  product_id text not null check (product_id in ('premium_opportunity_report')),
  reference_address text not null unique,
  treasury_address text not null,
  expected_lamports bigint not null check (expected_lamports > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'refunded')),
  tx_signature text unique,
  payer_address text,
  report_snapshot jsonb not null,
  payment_url text,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status <> 'paid') or (tx_signature is not null and verified_at is not null))
);

create index if not exists paid_report_invoices_pending_expiry_idx
  on public.paid_report_invoices (expires_at)
  where status = 'pending';

alter table public.paid_report_invoices enable row level security;
revoke all on table public.paid_report_invoices from anon, authenticated;
grant all on table public.paid_report_invoices to service_role;

comment on table public.paid_report_invoices is
  'Server-only native SOL paid-report invoices and verified receipts. report_snapshot contains only real source records.';
