-- Run this ONCE in your Supabase SQL editor
-- Go to: Supabase Dashboard → SQL Editor → paste → Run

create table if not exists stock (
  id         text primary key,   -- menu item id e.g. 'ayam', 'daging'
  qty        integer not null default 0,
  updated_at timestamptz default now()
);

-- Allow anon key to read and write
alter table stock enable row level security;
create policy "anon can manage stock" on stock
  for all using (true) with check (true);

-- Enable Realtime on stock table so changes broadcast to all devices instantly
alter publication supabase_realtime add table stock;
