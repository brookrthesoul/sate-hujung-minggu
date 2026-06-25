-- Run this once in your Supabase SQL editor
create table if not exists push_subscriptions (
  id          bigint generated always as identity primary key,
  endpoint    text unique not null,
  keys        jsonb not null,
  created_at  timestamptz default now()
);

-- Allow the anon key to read/write (your PWA uses the anon key)
alter table push_subscriptions enable row level security;
create policy "anon can manage own sub" on push_subscriptions
  for all using (true) with check (true);
