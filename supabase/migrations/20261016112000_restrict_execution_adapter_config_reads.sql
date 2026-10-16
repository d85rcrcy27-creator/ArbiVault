-- Execution adapters include signer references and signing/broadcast policy.
-- Backend Edge Functions use service-role access; authenticated clients should not enumerate them.
drop policy if exists execution_adapters_owner_read on public.execution_adapters;
