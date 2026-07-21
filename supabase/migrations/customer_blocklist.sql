-- Run this ONCE in your Supabase SQL editor (after customer_order_rpc.sql)
--
-- Lets the shop block abusive customers by phone number, device, or IP address.
-- IMPORTANT — read this before relying on it:
--   • Phone-number blocking is the most reliable of the three (a fake order still
--     needs *some* phone number typed in).
--   • Device blocking uses a random ID the browser generates and stores in
--     localStorage. It survives normal use, but is gone if the person clears
--     their browser data, uses a different browser, or uses private/incognito mode.
--   • IP blocking uses the "x-forwarded-for" header Supabase's edge network sets on
--     each request. It works, but people on mobile data or public Wi-Fi often share
--     an IP with many other genuine customers (carrier-grade NAT), so blocking an
--     IP can occasionally catch innocent people too. Use it for clearly abusive,
--     repeated cases rather than as a first response.
-- None of this is unbeatable (nothing client-side ever fully is), but together
-- these three signals make casual, repeat abuse meaningfully harder.

create table if not exists blocked_customers (
    id         bigserial primary key,
    type       text not null check (type in ('phone','ip','device')),
    value      text not null,
    reason     text,
    blocked_at timestamptz not null default now(),
    unique (type, value)
);

alter table blocked_customers enable row level security;

drop policy if exists "anon can read blocked_customers" on blocked_customers;
create policy "anon can read blocked_customers"
    on blocked_customers for select
    to anon
    using (true);

-- ─── Block / unblock (called from the admin app) ───────────────────────────────
create or replace function block_customer(p_type text, p_value text, p_reason text default null)
returns void
language plpgsql
security definer
as $$
begin
    if p_type not in ('phone','ip','device') then
        raise exception 'invalid block type: %', p_type;
    end if;
    if p_value is null or trim(p_value) = '' then
        raise exception 'a value is required to block';
    end if;

    insert into blocked_customers (type, value, reason)
    values (p_type, trim(p_value), nullif(trim(coalesce(p_reason, '')), ''))
    on conflict (type, value) do update
        set reason = excluded.reason, blocked_at = now();
end;
$$;
grant execute on function block_customer(text, text, text) to anon;

create or replace function unblock_customer(p_type text, p_value text)
returns void
language plpgsql
security definer
as $$
begin
    delete from blocked_customers where type = p_type and value = trim(p_value);
end;
$$;
grant execute on function unblock_customer(text, text) to anon;

-- ─── Order placement — now checks the blocklist and records IP/device ──────────
-- (Same stock-check logic as before, with a blocklist check added up front and
--  the caller's IP/device stamped onto the saved order for the admin app to see.)
create or replace function place_customer_order(order_data jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_id    text;
    item_qty   integer;
    avail_qty  integer;
    new_id     bigint;
    items      jsonb;
    client_ip  text;
    device_val text;
    phone_val  text;
    is_blocked boolean;
begin
    items := order_data -> 'items';

    -- Best-effort caller identification.
    -- Supabase's edge network sets x-forwarded-for; the first address in that
    -- (possibly comma-separated) list is the original client.
    client_ip  := nullif(trim(split_part(
                      coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
                      ',', 1)), '');
    device_val := nullif(trim(order_data ->> 'deviceId'), '');
    phone_val  := nullif(trim(order_data ->> 'customerPhone'), '');

    select exists(
        select 1 from blocked_customers
        where (type = 'ip'     and value = client_ip)
           or (type = 'device' and value = device_val)
           or (type = 'phone'  and value = phone_val)
    ) into is_blocked;

    if is_blocked then
        return jsonb_build_object('ok', false, 'reason', 'blocked');
    end if;

    -- Stamp IP/device onto the order so the admin app can offer "Block" on it later.
    order_data := order_data || jsonb_build_object('orderIp', client_ip, 'deviceId', device_val);

    -- Lock stock rows and check availability
    for item_id, item_qty in
        select key, (value->>'qty')::integer
        from jsonb_each(items)
        where (value->>'qty')::integer > 0
    loop
        select qty into avail_qty
        from stock
        where id = item_id
        for update; -- row-level lock

        if avail_qty is not null and avail_qty < item_qty then
            if avail_qty = 0 then
                return jsonb_build_object('ok', false, 'reason', 'out_of_stock', 'item', item_id);
            else
                return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', avail_qty);
            end if;
        end if;
    end loop;

    -- Deduct stock
    for item_id, item_qty in
        select key, (value->>'qty')::integer
        from jsonb_each(items)
        where (value->>'qty')::integer > 0
    loop
        update stock
        set qty = greatest(0, qty - item_qty),
            updated_at = now()
        where id = item_id
          and qty is not null;
    end loop;

    -- Insert order
    insert into orders (data, updated_ms)
    values (order_data, extract(epoch from now()) * 1000)
    returning id into new_id;

    return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

grant execute on function place_customer_order(jsonb) to anon;
