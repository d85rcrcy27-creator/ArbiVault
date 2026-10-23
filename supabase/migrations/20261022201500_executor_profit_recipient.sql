-- Record and verify an immutable flash-executor profit destination separately from its trading caller.
alter table public.flash_executor_deployments
  add column if not exists profit_recipient_wallet_id uuid references public.wallets(id) on delete set null,
  add column if not exists profit_recipient_address text;

alter table public.flash_executor_deployments
  drop constraint if exists flash_executor_profit_recipient_shape;

alter table public.flash_executor_deployments
  add constraint flash_executor_profit_recipient_shape
  check (
    (profit_recipient_wallet_id is null and profit_recipient_address is null)
    or (
      profit_recipient_wallet_id is not null
      and profit_recipient_address ~ '^0x[0-9a-fA-F]{40}$'
      and lower(profit_recipient_address) <> lower(coalesce(hot_wallet_address, ''))
    )
  );
