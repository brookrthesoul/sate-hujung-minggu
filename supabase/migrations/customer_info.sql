-- Run this ONCE in your Supabase SQL editor
-- Stores the "Info" sub-tab content (Menu tab shown to customers).
-- Uses the existing `settings` table (key='customerInfo', value=JSON string)
-- plus a public Storage bucket for the uploaded pictures.

-- Storage bucket for menu/info pictures
insert into storage.buckets (id, name, public)
values ('customer-info', 'customer-info', true)
on conflict (id) do nothing;

-- Allow anon key to upload/replace/read/delete files in this bucket
-- (matches the rest of this app, which has no auth and trusts the device)
create policy "anon can read customer-info files"
    on storage.objects for select
    using (bucket_id = 'customer-info');

create policy "anon can upload customer-info files"
    on storage.objects for insert
    with check (bucket_id = 'customer-info');

create policy "anon can update customer-info files"
    on storage.objects for update
    using (bucket_id = 'customer-info');

create policy "anon can delete customer-info files"
    on storage.objects for delete
    using (bucket_id = 'customer-info');

-- Seed an empty customerInfo record so the app has something to read
insert into settings (key, value) values (
    'customerInfo',
    '{"header":"Our Menu","items":[],"otherInfo":""}'
)
on conflict (key) do nothing;
