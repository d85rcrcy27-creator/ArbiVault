-- Human-in-the-loop signing approval layer.
-- QR values are short-lived bearer challenges; never store private keys or seeds.

alter table public.signing_requests
  add column if not exists approval_challenge_hash text,
  add column if not exists approval_expires_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists approval_method text;

create unique index if not exists signing_requests_approval_challenge_hash_idx
  on public.signing_requests(approval_challenge_hash)
  where approval_challenge_hash is not null;

create index if not exists signing_requests_pending_approval_idx
  on public.signing_requests(owner_id, status, approval_expires_at)
  where status in ('pending','authorized');

comment on column public.signing_requests.approval_challenge_hash is
  'SHA-256 of a short-lived QR approval token. Never store the raw token.';
comment on column public.signing_requests.approval_method is
  'Human authorization method, e.g. passkey_qr.';
