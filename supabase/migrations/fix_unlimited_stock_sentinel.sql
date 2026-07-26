-- Run this ONCE in your Supabase SQL editor if you already ran
-- harden_customer_orders.sql — it patches a bug in that migration and is
-- otherwise a no-op (skip it on a brand-new setup where you haven't run
-- harden_customer_orders.sql yet; that file already has this fix built in).
--
-- The bug: this app's convention for "no stock limit set" on an item is a
-- qty of -1 (see stock.js — clearing a limit writes -1, not NULL). The
-- place_customer_order/edit_my_order/cancel_my_order functions only checked
-- for NULL, not -1, so an item with no limit set was treated as having
-- "-1 left in stock" — blocking every order for it with a confusing
-- "Insufficient stock: <item> — only -1 left" message, and (worse) the
-- stock-deduct/return steps would have permanently overwritten that -1 with
-- a real (wrong) number the first time it happened to slip through.
--
-- This simply re-defines the same three functions with that fixed — nothing
-- else changes, and running this is safe even if you're not sure whether
-- you're affected.

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
    new_token  uuid := gen_random_uuid();
    real_items jsonb;
    totals     jsonb;
    kuah_ratio integer;
    client_ip  text;
    device_val text;
    phone_val  text;
    is_blocked boolean;
begin
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

    real_items := _rebuild_order_items(order_data -> 'items');
    if real_items = '{}'::jsonb then
        return jsonb_build_object('ok', false, 'reason', 'no_items');
    end if;

    select value::integer into kuah_ratio from settings where key = 'kuahRatio';
    totals := _order_totals(real_items, coalesce(kuah_ratio, 10));

    -- A qty of -1 means "no limit set" — never treat it as "-1 left".
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

    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        update stock set qty = greatest(0, qty - item_qty), updated_at = now()
        where id = item_id and qty is not null and qty <> -1;
    end loop;

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


create or replace function edit_my_order(p_order_id bigint, p_token uuid, p_items jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
as $$
declare
    old_data   jsonb;
    old_items  jsonb;
    real_items jsonb;
    totals     jsonb;
    kuah_ratio integer;
    item_id    text;
    old_qty    integer;
    new_qty    integer;
    diff       integer;
    avail_qty  integer;
begin
    select data into old_data from orders where id = p_order_id and order_token = p_token for update;
    if old_data is null then
        return jsonb_build_object('ok', false, 'reason', 'not_found_or_forbidden');
    end if;

    old_items  := coalesce(old_data -> 'items', '{}'::jsonb);
    real_items := _rebuild_order_items(p_items);
    if real_items = '{}'::jsonb then
        return jsonb_build_object('ok', false, 'reason', 'no_items');
    end if;

    for item_id in
        select distinct key from (
            select key from jsonb_each(old_items)
            union select key from jsonb_each(real_items)
        ) t
    loop
        old_qty := coalesce((old_items -> item_id ->> 'qty')::integer, 0);
        new_qty := coalesce((real_items -> item_id ->> 'qty')::integer, 0);
        diff    := new_qty - old_qty;
        if diff > 0 then
            select qty into avail_qty from stock where id = item_id for update;
            if avail_qty is not null and avail_qty <> -1 and avail_qty < diff then
                return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', avail_qty);
            end if;
        end if;
    end loop;

    for item_id in
        select distinct key from (
            select key from jsonb_each(old_items)
            union select key from jsonb_each(real_items)
        ) t
    loop
        old_qty := coalesce((old_items -> item_id ->> 'qty')::integer, 0);
        new_qty := coalesce((real_items -> item_id ->> 'qty')::integer, 0);
        diff    := new_qty - old_qty;
        if diff <> 0 then
            update stock set qty = greatest(0, qty - diff), updated_at = now()
            where id = item_id and qty is not null and qty <> -1;
        end if;
    end loop;

    select value::integer into kuah_ratio from settings where key = 'kuahRatio';
    totals := _order_totals(real_items, coalesce(kuah_ratio, 10));

    update orders
    set data = old_data || jsonb_build_object('items', real_items, 'description', coalesce(p_note, '')) || totals,
        updated_ms = extract(epoch from now()) * 1000
    where id = p_order_id and order_token = p_token;

    return jsonb_build_object('ok', true);
end;
$$;

grant execute on function edit_my_order(bigint, uuid, jsonb, text) to anon;


create or replace function cancel_my_order(p_order_id bigint, p_token uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
    old_data jsonb;
    item_id  text;
    item_qty integer;
begin
    select data into old_data from orders where id = p_order_id and order_token = p_token;
    if old_data is null then
        return jsonb_build_object('ok', false, 'reason', 'not_found_or_forbidden');
    end if;

    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(coalesce(old_data -> 'items', '{}'::jsonb))
        where (value->>'qty')::integer > 0
    loop
        update stock set qty = qty + item_qty, updated_at = now()
        where id = item_id and qty is not null and qty <> -1;
    end loop;

    delete from orders where id = p_order_id and order_token = p_token;
    return jsonb_build_object('ok', true);
end;
$$;

grant execute on function cancel_my_order(bigint, uuid) to anon;
