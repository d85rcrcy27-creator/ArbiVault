-- Fix ArbiVault signer access to Supabase Vault secrets.
-- SECURITY DEFINER changes current_user to the function owner; authorize by JWT role instead.
-- Resolve the persisted Vault secret UUID first, retaining a legacy-name fallback only
-- for older wallets whose secret_ref is null. Never return secrets to client-facing paths.

create or replace function public.get_wallet_secret(p_wallet_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $function$
declare
  v_secret text;
  v_secret_ref text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service access required';
  end if;

  if p_wallet_id is null then
    raise exception 'wallet id is required';
  end if;

  select w.secret_ref
    into v_secret_ref
  from public.wallets w
  where w.id = p_wallet_id
    and w.status = 'active'
    and w.is_hot = true
    and w.wallet_role = 'trading_hot';

  if not found then
    raise exception 'active trading hot wallet required';
  end if;

  if v_secret_ref is not null and length(v_secret_ref) > 0 then
    select ds.decrypted_secret
      into v_secret
    from vault.decrypted_secrets ds
    where ds.id::text = v_secret_ref
    limit 1;
  else
    -- Compatibility for older rows that predate secret_ref persistence.
    select ds.decrypted_secret
      into v_secret
    from vault.decrypted_secrets ds
    where ds.name = 'arbivault-wallet-' || p_wallet_id::text
    limit 1;
  end if;

  if v_secret is null or length(v_secret) = 0 then
    raise exception 'wallet_secret_unavailable';
  end if;

  return v_secret;
end
$function$;

revoke all on function public.get_wallet_secret(uuid) from public, anon, authenticated;
grant execute on function public.get_wallet_secret(uuid) to service_role;
