-- Supabase setup for Wine Order Count.
-- These public RLS policies are for personal testing only and are not secure
-- for public production use. Add authentication and store-scoped policies
-- before sharing this app broadly.

create table if not exists store_app_state (
  store_number text primary key,
  app_state jsonb not null,
  updated_at timestamptz default now()
);

alter table store_app_state enable row level security;

create policy "Allow public read"
on store_app_state
for select
using (true);

create policy "Allow public insert"
on store_app_state
for insert
with check (true);

create policy "Allow public update"
on store_app_state
for update
using (true)
with check (true);
