-- Keep route metadata truthful: these Jupiter builders produce a single swap,
-- not an atomic multi-leg cyclic/multi-venue execution transaction.
update public.arbivault_strategy_routes
set builder_enabled=false,
    builder_status='requires_atomic_multileg_builder',
    updated_at=now()
where id in (
  'f260c1f4-5489-41ad-bf5e-e1fb37ed0904',
  '8baffc5d-4344-427c-b70c-8b0c90d30e13'
);
