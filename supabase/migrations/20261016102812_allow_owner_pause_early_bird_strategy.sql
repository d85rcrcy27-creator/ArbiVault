-- Allow authenticated users to pause or resume only their own strategy rows.
-- Applied to the production Supabase project on 2026-10-16.
create policy strategy_bots_owner_update
on public.arbivault_strategy_bots
for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));
