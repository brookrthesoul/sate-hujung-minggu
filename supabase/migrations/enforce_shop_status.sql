-- Run this ONCE in your Supabase SQL editor, AFTER harden_customer_orders.sql.
--
-- What this closes:
--   place_customer_order never checked the shop's open/closed status or the
--   preorder-enabled setting at all — the "We are Closed" banner and the
--   "can't submit" validation in order.html were the ONLY thing stopping an
--   order from going through while closed, and both live entirely in the
--   customer's browser. That meant:
--     - Going offline made the client fall back to "assume open" (a bug in
--       order.html, fixed separately), so the customer could fill out and
--       submit a normal (today) order while the shop was actually closed,
--       as long as the connection came back before they tapped submit.
--     - Even without that bug, anyone could open DevTools and call
--       place_customer_order directly, any time, regardless of the admin's
--       shop-open toggle — the database itself never said no.
--   This migration adds that check inside the function itself, so it's
--   enforced no matter what the client believes or sends.
--
-- Logic mirrors order.html's existing client-side check:
--   - A "today" order (pickupMode is null, 'time', or 'date-today') is
--     rejected if the shop is currently closed.
--   - A preorder (pickupMode is 'date' or 'datetime', i.e. a future date)
--     is rejected if preorder is currently disabled.

create or replace function place_customer_order(order_data jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_id         text;
    item_qty        integer;
    avail_qty       integer;
    new_id          bigint;
    new_token       uuid := gen_random_uuid();
    real_items      jsonb;
    totals          jsonb;
    kuah_ratio      integer;
    client_ip       text;
    device_val      text;
    phone_val       text;
    is_blocked      boolean;
    shop_open       boolean;
    preorder_on     boolean;
    pickup_mode     text;
    is_today_order  boolean;
begin
    -- Best-effort caller identification (unchanged from customer_blocklist.sql).
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

    -- Server-side shop-open / preorder-enabled check — see header comment.
    -- Defaults (true) match order.html's own defaults if a setting row is
    -- somehow missing, so a missing row never accidentally blocks orders.
    select coalesce((select value from settings where key = 'shopOpen') = 'true', true)
      into shop_open;
    select coalesce((select value from settings where key = 'preorderEnabled') <> 'false', true)
      into preorder_on;

    pickup_mode    := nullif(trim(order_data ->> 'pickupMode'), '');
    is_today_order := pickup_mode is null or pickup_mode in ('time', 'date-today');

    if is_today_order and not shop_open then
        return jsonb_build_object('ok', false, 'reason', 'shop_closed');
    end if;

    if not is_today_order and not preorder_on then
        return jsonb_build_object('ok', false, 'reason', 'preorder_disabled');
    end if;

    -- Rebuild items from the live menu — ignore whatever price/name/category
    -- the browser sent; only the item id + qty are taken from it.
    real_items := _rebuild_order_items(order_data -> 'items');
    if real_items = '{}'::jsonb then
        return jsonb_build_object('ok', false, 'reason', 'no_items');
    end if;

    select value::integer into kuah_ratio from settings where key = 'kuahRatio';
    totals := _order_totals(real_items, coalesce(kuah_ratio, 10));

    -- Lock stock rows and check availability. A qty of -1 is this app's
    -- convention for "no limit set" (see stock.js/_writeStock) — NULL alone
    -- isn't enough to detect that, since admins can explicitly clear a limit
    -- to -1 rather than deleting the row.
    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        select qty into avail_qty from stock where id = item_id for update;
        if avail_qty is not null and avail_qty <> -1 and avail_qty < item_qty then
            if avail_qty = 0 then
                return jsonb_build_object('ok', false, 'reason', 'out_of_stock', 'item', item_id);
            else
                return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', avail_qty);
            end if;
        end if;
    end loop;

    -- Deduct stock (skip unlimited items — never turn a -1 into a real number)
    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        update stock set qty = greatest(0, qty - item_qty), updated_at = now()
        where id = item_id and qty is not null and qty <> -1;
    end loop;

    -- Assemble the final order — items/prices/totals are entirely our own
    -- computed values now; only the customer's non-financial fields (note,
    -- name, phone, pickup time, etc.) pass through as submitted.
    order_data := order_data
        || jsonb_build_object('items', real_items)
        || totals
        || jsonb_build_object('orderIp', client_ip, 'deviceId', device_val);

    insert into orders (data, updated_ms, order_token)
    values (order_data, extract(epoch from now()) * 1000, new_token)
    returning id into new_id;

    return jsonb_build_object('ok', true, 'id', new_id, 'token', new_token);
end;
$$;

grant execute on function place_customer_order(jsonb) to anon;
