-- Discovery-only routes are research metadata, never execution routes.
update public.arbivault_strategy_routes
set enabled = false
where discovery_only = true;
