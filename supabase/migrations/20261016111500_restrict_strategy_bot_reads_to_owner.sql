-- Prevent authenticated users from reading other owners' strategy rows.
-- The table contains owner IDs and private strategy configuration.
drop policy if exists strategy_bots_authenticated_read on public.arbivault_strategy_bots;
create policy strategy_bots_owner_read
on public.arbivault_strategy_bots
for select to authenticated
using (owner_id = (select auth.uid()));
