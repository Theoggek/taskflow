-- ─────────────────────────────────────────────────────────────────────────
-- TaskFlow — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.user_data (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete cascade not null unique,
  todos          jsonb    not null default '[]',
  task_xp        integer  not null default 0,
  subtask_xp     integer  not null default 0,
  subtask_streak jsonb    not null default '{"count": 0, "date": ""}',
  achievements   jsonb    not null default '[]',
  archive        jsonb    not null default '[]',
  brain_dump_count integer not null default 0,
  daily_streak   jsonb    not null default '{"days": []}',
  templates      jsonb    not null default '[]',
  theme          text     not null default 'dark',
  updated_at     timestamptz not null default now()
);

-- Auto-update the updated_at timestamp on every save
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at
  before update on public.user_data
  for each row execute function update_updated_at();

-- Row Level Security: users can only read/write their own row
alter table public.user_data enable row level security;

create policy "Users can read own data"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own data"
  on public.user_data for update
  using (auth.uid() = user_id);

create policy "Users can delete own data"
  on public.user_data for delete
  using (auth.uid() = user_id);
