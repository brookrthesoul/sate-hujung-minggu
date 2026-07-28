-- ============================================================================
-- ⚠️ SUPERSEDED — see box_stock_v2_unified.sql instead.
-- This file is kept for history only. If you're setting this up fresh, skip
-- straight to box_stock_v2_unified.sql (after box_stock.sql). Do not run
-- this file after box_stock_v2_unified.sql — it would undo it.
-- ============================================================================
--
-- FIX: place_customer_order regression from box_stock.sql
-- Run this ONCE in your Supabase SQL editor, AFTER box_stock.sql.
-- ============================================================================
--
-- box_stock.sql's version of place_customer_order was written by extending
-- the OLDER, simpler function from customer_order_rpc.sql — it didn't know
-- about harden_customer_orders.sql, which had already replaced that function
-- with a more complete/secure one. Running box_stock.sql silently overwrote
-- that hardened version and dropped:
--
--   1. The blocked-customer check (IP/device/phone blocklist)
--   2. Server-side price/total recomputation from the live menu (protection
--      against a tampered order request)
--   3. Issuing the order_token a customer needs to later edit/cancel their
--      own order — orders placed while the box_stock.sql version was live
--      got a random token from the column default but the function never
--      RETURNED it to the customer's browser, so those specific orders
--      can't be edited/cancelled from the customer's "My Order" tab (the
--      admin side is completely unaffected and can manage them normally)
--   4. The "-1 means no limit" stock sentinel fix — this is the bug you
--      just ran into ("Insufficient stock: Ayam — only -1 left")
--
-- This migration puts all four back, with the Box logic (Box-first, then
-- raw stock for the shortfall) correctly layered on top instead of bolted
-- onto the wrong base. Safe to run even if you're not sure exactly when you
-- ran box_stock.sql — this fully replaces that function again.
-- ============================================================================

create or replace function place_customer_order(order_data jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_id    text;
    item_qty   integer;
    avail_qty  integer;
    box_qty    integer;
    box_used   integer;
    shortfall  integer;
    new_id     bigint;
    new_token  uuid := gen_random_uuid();
    real_items jsonb;
    totals     jsonb;
    kuah_ratio integer;
    client_ip  text;
    device_val text;
    phone_val  text;
    is_blocked boolean;
    shortfalls jsonb := '{}'::jsonb; -- item_id -> shortfall qty (post-box)
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

    -- Rebuild items from the live menu — ignore whatever price/name/category
    -- the browser sent; only the item id + quantity are taken from it.
    real_items := _rebuild_order_items(order_data -> 'items');
    if real_items = '{}'::jsonb then
        return jsonb_build_object('ok', false, 'reason', 'no_items');
    end if;

    select value::integer into kuah_ratio from settings where key = 'kuahRatio';
    totals := _order_totals(real_items, coalesce(kuah_ratio, 10));

    -- Pass 1 (Box): work out how much of each item's demand the Box can
    -- cover right now (already cooked, sitting ready), and how much is left
    -- over — the shortfall — that still needs a raw-stock check.
    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        select qty into box_qty from box_stock where id = item_id for update;
        box_qty    := coalesce(box_qty, 0);
        box_used   := least(box_qty, item_qty);
        shortfall  := item_qty - box_used;
        shortfalls := shortfalls || jsonb_build_object(item_id, shortfall);
    end loop;

    -- Pass 2 (raw stock): lock stock rows and check availability against the
    -- SHORTFALL only. A qty of -1 is this app's convention for "no limit
    -- set" (see stock.js/_writeStock) — never treat it as "-1 left".
    for item_id in select key from jsonb_each(shortfalls)
    loop
        shortfall := (shortfalls ->> item_id)::integer;
        if shortfall > 0 then
            select qty into avail_qty from stock where id = item_id for update;
            if avail_qty is not null and avail_qty <> -1 and avail_qty < shortfall then
                if avail_qty = 0 then
                    return jsonb_build_object('ok', false, 'reason', 'out_of_stock', 'item', item_id);
                else
                    return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', avail_qty);
                end if;
            end if;
        end if;
    end loop;

    -- Pass 3: everything checks out — deduct the Box (qty only, cooked_total
    -- untouched — see box_stock.sql) and deduct raw stock for the shortfall
    -- only (skip unlimited items — never turn a -1 into a real number).
    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        shortfall := (shortfalls ->> item_id)::integer;
        box_used  := item_qty - shortfall;
        if box_used > 0 then
            update box_stock set qty = greatest(0, qty - box_used), updated_at = now()
            where id = item_id;
        end if;
        if shortfall > 0 then
            update stock set qty = greatest(0, qty - shortfall), updated_at = now()
            where id = item_id and qty is not null and qty <> -1;
        end if;
    end loop;

    -- Assemble the final order — items/prices/totals are entirely our own
    -- computed values; only the customer's non-financial fields (note, name,
    -- phone, pickup time, etc.) pass through as submitted.
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
