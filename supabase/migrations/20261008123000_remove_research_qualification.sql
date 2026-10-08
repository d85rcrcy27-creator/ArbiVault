-- Research observations are observation-only. Qualification is not an execution concept.
alter table public.strategy_observations
  drop column if exists qualifying;
