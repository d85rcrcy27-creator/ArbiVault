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
  retry_count integer not null default 0,
  max_retries integer not null default 3,
  completion_evidence jsonb,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.agent_tasks enable row level security;

create policy "Users can view own agent tasks" on public.agent_tasks
  for select using (auth.uid() = owner_id or owner_id is null);

create policy "Users can insert own agent tasks" on public.agent_tasks
  for insert with check (auth.uid() = owner_id or owner_id is null);

create policy "Users can update own agent tasks" on public.agent_tasks
  for update using (auth.uid() = owner_id or owner_id is null);

create index if not exists agent_tasks_status_idx on public.agent_tasks(status);
create index if not exists agent_tasks_owner_id_idx on public.agent_tasks(owner_id);
