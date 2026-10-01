-- Service-only bridge for wallet custody secrets. The secret value never lives in public.wallets.
create or replace function public.store_wallet_secret(p_wallet_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,public,vault
as $$
declare v_secret_id uuid;
begin
  if current_user <> 'service_role' then raise exception 'service access required'; end if;
  if p_wallet_id is null or length(coalesce(p_secret,''))=0 then raise exception 'wallet secret input is invalid'; end if;
  select vault.create_secret(p_secret,'arbivault-wallet-'||p_wallet_id::text,'ArbiVault hot-wallet custody secret') into v_secret_id;
  return v_secret_id;
end $$;
revoke all on function public.store_wallet_secret(uuid,text) from public,anon,authenticated;
grant execute on function public.store_wallet_secret(uuid,text) to service_role;
