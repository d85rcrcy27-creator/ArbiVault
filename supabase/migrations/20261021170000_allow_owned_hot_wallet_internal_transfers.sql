-- Permit same-owner, same-chain hot-wallet transfers without weakening external destination approval.
-- Existing external withdrawals still require an approved_wallets row.
create or replace function public.enforce_wallet_activation_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  approved_status text;
  destination_wallet_id uuid;
begin
  if new.transaction_class <> 'trade' and new.status in ('activated', 'broadcast', 'confirmed') then
    if new.transaction_class = 'transfer'
       and nullif(new.transaction_payload->>'destination_wallet_id', '') is not null then
      destination_wallet_id := (new.transaction_payload->>'destination_wallet_id')::uuid;

      if not exists (
        select 1
        from public.wallets w
        where w.id = destination_wallet_id
          and w.owner_id = new.owner_id
          and w.chain = new.chain
          and w.address = new.destination_address
          and w.id <> new.source_wallet_id
          and w.status = 'active'
          and w.is_hot = true
          and w.wallet_role = 'trading_hot'
      ) then
        raise exception 'WALLET_APPROVAL_GATE: internal destination must be another active same-chain hot wallet owned by this user';
      end if;
    else
      if new.approved_wallet_id is null then
        raise exception 'WALLET_APPROVAL_GATE: approved_wallet_id required before activation';
      end if;

      select status into approved_status
      from public.approved_wallets
      where id = new.approved_wallet_id;

      if approved_status is distinct from 'approved' then
        raise exception 'WALLET_APPROVAL_GATE: referenced wallet is not approved';
      end if;
    end if;
  end if;
  return new;
end;
$$;
