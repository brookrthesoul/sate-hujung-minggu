-- Run this ONCE in your Supabase SQL editor if the menu table doesn't exist yet

create table if not exists menu (
    id         text primary key,
    name       text not null,
    price      numeric(10,2) not null default 0,
    category   text not null default 'skewer',
    unit_label text,
    sort_order integer not null default 0
);

alter table menu enable row level security;
create policy "anon can read and write menu" on menu
    for all using (true) with check (true);

-- Enable Realtime so customer page updates when menu changes
alter publication supabase_realtime add table menu;
