-- ArbiVault: real-only custody/reconciliation pipeline.
-- No wallet balance is authoritative in application tables.
-- Private signing material is server-side only and never returned to clients.

alter table public.wallets
  add column if not exists secret_ref text,
  add column if not exists signer_version integer not null default 1;

create index if not exists wallets_secret_ref_idx on public.wallets(secret_ref);

create table if not exists public.reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid references public.wallets(id) on delete set null,
  chain text,
  tx_hash text,
  payment_id uuid references public.payments(id) on delete set null,
  trade_id uuid references public.trades(id) on delete set null,
  event_type text not null,
  status text not null,
  source text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reconciliation_events_owner_created_idx
  on public.reconciliation_events(owner_id, created_at desc);
create unique index if not exists reconciliation_events_chain_tx_idx
  on public.reconciliation_events(chain, tx_hash)
  where tx_hash is not null;

alter table public.reconciliation_events enable row level security;
create policy reconciliation_events_owner_read
  on public.reconciliation_events for select to authenticated
  using ((select auth.uid()) = owner_id);

-- A wallet secret is referenced by Vault, never stored in public.wallets.
create or replace function public.store_wallet_secret(p_wallet_id uuid, p_secret text)
returns text
language plpgsql security definer
set search_path = public, vault
as $$
declare
  ref text;
  owner uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select owner_id into owner from public.wallets where id = p_wallet_id for update;
  if owner is null then raise exception 'wallet not found'; end if;
  ref := 'arbivault/wallet/' || p_wallet_id::text;
  delete from vault.secrets where name = ref;
  perform vault.create_secret(p_secret, ref, 'ArbiVault wallet signing secret');
  update public.wallets
    set secret_ref = ref, custody_type = 'server_vault'
    where id = p_wallet_id;
  return ref;
end;
$$;
revoke all on function public.store_wallet_secret(uuid,text) from public, anon, authenticated;
grant execute on function public.store_wallet_secret(uuid,text) to service_role;

create or replace function public.get_wallet_secret(p_wallet_id uuid)
returns text
language sql security definer
set search_path = public, vault
as $$
  select ds.decrypted_secret
  from public.wallets w
  join vault.decrypted_secrets ds on ds.name = w.secret_ref
  where w.id = p_wallet_id and w.secret_ref is not null;
$$;
revoke all on function public.get_wallet_secret(uuid) from public, anon, authenticated;
grant execute on function public.get_wallet_secret(uuid) to service_role;

-- Only the server-side reconciliation worker may create authoritative reconciliation events.
create or replace function public.record_reconciliation_event(
  p_wallet_id uuid, p_chain text, p_tx_hash text, p_payment_id uuid,
  p_trade_id uuid, p_event_type text, p_status text, p_source text,
  p_details jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  rid uuid;
  oid uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select owner_id into oid from public.wallets where id = p_wallet_id;
  if oid is null and p_payment_id is not null then
    select owner_id into oid from public.payments where id = p_payment_id;
  end if;
  if oid is null and p_trade_id is not null then
    select owner_id into oid from public.trades where id = p_trade_id;
  end if;
  if oid is null then raise exception 'owner could not be resolved'; end if;
  insert into public.reconciliation_events(
    owner_id,wallet_id,chain,tx_hash,payment_id,trade_id,
    event_type,status,source,details
  ) values (
    oid,p_wallet_id,p_chain,p_tx_hash,p_payment_id,p_trade_id,
    p_event_type,p_status,p_source,coalesce(p_details,'{}'::jsonb)
  )
  on conflict (chain,tx_hash) where tx_hash is not null
  do update set status=excluded.status, details=excluded.details
  returning id into rid;
  return rid;
end;
$$;
revoke all on function public.record_reconciliation_event(uuid,text,text,uuid,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.record_reconciliation_event(uuid,text,text,uuid,uuid,text,text,text,jsonb) to service_role;
