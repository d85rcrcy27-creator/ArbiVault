create table if not exists public.agent_tasks (
  id uuid default gen_random_uuid() primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'running', 'completed', 'failed', 'retrying')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'p0', 'p1', 'p2')),
  assigned_agent text,
  claimed_at timestamp with time zone,
  lease_expires_at timestamp with time zone,
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries >= 0),
  completion_evidence jsonb,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.agent_tasks enable row level security;

-- Users only see and change their own rows. Shared rows (owner_id is null) are
-- reachable only through the service-role dispatcher, never directly.
create policy "Users can view own agent tasks" on public.agent_tasks
  for select to authenticated using (auth.uid() = owner_id);

create policy "Users can insert own agent tasks" on public.agent_tasks
  for insert to authenticated with check (auth.uid() = owner_id);

create policy "Users can update own agent tasks" on public.agent_tasks
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create index if not exists agent_tasks_status_idx on public.agent_tasks(status);
create index if not exists agent_tasks_owner_id_idx on public.agent_tasks(owner_id);
create index if not exists agent_tasks_lease_idx on public.agent_tasks(lease_expires_at) where status in ('claimed', 'running');

-- Registered agent identities: the dispatcher only lets these claim/complete tasks.
create table if not exists public.agent_registry (
  agent_name text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.agent_registry enable row level security;

create policy "Users can view own registered agents" on public.agent_registry
  for select to authenticated using (auth.uid() = owner_id);

create index if not exists agent_registry_owner_id_idx on public.agent_registry(owner_id);
