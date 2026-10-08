-- Link market observations to both the observed strategy route and the executable route.
-- Execution remains gated by transaction-builder and signer controls; observation alone
-- never authorizes a trade.

alter table public.strategy_observations
  add column if not exists observed_route_id uuid references public.arbivault_strategy_routes(id),
  add column if not exists execution_route_id uuid references public.arbivault_strategy_routes(id),
  add column if not exists strategy_bot_id uuid references public.arbivault_strategy_bots(id),
  add column if not exists execution_bot_config_id uuid references public.bot_configs(id),
  add column if not exists qualifying boolean not null default false;

create index if not exists strategy_observations_execution_bot_idx
  on public.strategy_observations(execution_bot_config_id, observed_at desc);

create index if not exists strategy_observations_routes_idx
  on public.strategy_observations(observed_route_id, execution_route_id, observed_at desc);

alter table public.execution_attempts
  add column if not exists observation_id uuid references public.strategy_observations(id),
  add column if not exists observed_route_id uuid references public.arbivault_strategy_routes(id),
  add column if not exists execution_route_id uuid references public.arbivault_strategy_routes(id);

create index if not exists execution_attempts_observation_idx
  on public.execution_attempts(observation_id);

create index if not exists execution_attempts_execution_route_idx
  on public.execution_attempts(execution_route_id);
