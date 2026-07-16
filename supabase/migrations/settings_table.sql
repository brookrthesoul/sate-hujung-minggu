-- Run this ONCE in your Supabase SQL editor

create table if not exists settings (
    key        text primary key,
    value      text not null,
    updated_at timestamptz default now()
);

alter table settings enable row level security;
create policy "anon can read and write settings" on settings
    for all using (true) with check (true);

-- Enable Realtime so customer page updates instantly when you toggle open/close
alter publication supabase_realtime add table settings;

-- Insert default shop status (open)
insert into settings (key, value) values ('shopOpen', 'true')
on conflict (key) do nothing;
