-- ============================================================================
-- BOX + STOCK, UNIFIED MODEL (v2)
-- Run this ONCE in your Supabase SQL editor, AFTER box_stock.sql and
-- fix_box_stock_regression.sql have already been run.
-- ============================================================================
--
-- This is now the SINGLE SOURCE OF TRUTH for place_customer_order,
-- edit_my_order, and cancel_my_order. It supersedes:
--   - place_customer_order from box_stock.sql / fix_box_stock_regression.sql
--   - edit_my_order / cancel_my_order from harden_customer_orders.sql
-- (Those older files are left in place for history — DO NOT re-run them
-- after this one, or you'll undo this.)
--
-- WHAT CHANGED AND WHY — the mental model is now:
--   Stock and Box are the SAME underlying inventory, just in a different
--   state: Stock = raw/not yet cooked, Box = cooked/ready to pack. Cooking
--   is the "raw → cooked" conversion — see adjust_box_stock's caller in
--   box.js (cookIntoBox), which deducts Stock by the same amount it adds
--   to the Box. This SQL file doesn't touch that part (it's a client-side
--   local-first operation, kept offline-safe — see box.js/sync.js); it only
--   covers the order-placement/edit/cancel side.
--
--   Because Stock/Box now only change when the kitchen actually cooks
--   (Stock → Box) or when an order is packed at the Ready button (Box goes
--   down — see markPrepared() in orders.js) or un-packed via a cancel
--   before payment (Box goes back up — see deleteOrderConfirm()), NEITHER
--   Stock nor Box is touched at order placement/edit/cancel anymore. That
--   used to be where deduction happened; now it's purely a LIVE AVAILABILITY
--   CHECK with nothing to reserve or roll back:
--
--       available = (Stock + Box) − (everything still pending in Prepare)
--
--   "Pending" means every order that hasn't been marked prepared or paid
--   yet, and isn't a future-dated preorder (same exclusion rule used for
--   the admin Prepare tab and the customer-facing busy/not-busy badge — see
--   updateSateSummaryBar in orders.js and loadBusy() in order.html for the
--   client-side equivalents of this same formula).
--
--   Consequence: edit_my_order no longer deducts/returns stock on a qty
--   change, and cancel_my_order no longer returns stock at all — there's
--   nothing to give back, since nothing was taken in the first place. The
--   live formula above self-corrects automatically the moment an order's
--   items change or the order disappears, because it reads straight from
--   the `orders` table rather than a running counter that needs manual
--   reconciling.
-- ============================================================================


-- ── place_customer_order ────────────────────────────────────────────────────
create or replace function place_customer_order(order_data jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_id     text;
    item_qty    integer;
    avail_qty   integer;
    box_qty     integer;
    pending_qty integer;
    total_avail integer;
    new_id      bigint;
    new_token   uuid := gen_random_uuid();
    real_items  jsonb;
    totals      jsonb;
    kuah_ratio  integer;
    client_ip   text;
    device_val  text;
    phone_val   text;
    is_blocked  boolean;
    pending     jsonb;
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

    -- Pending demand today, across every not-yet-prepared, not-yet-paid
    -- order (same population as the admin Prepare tab / busy badge).
    select coalesce(jsonb_object_agg(t.item_id, t.total), '{}'::jsonb) into pending
    from (
        select it.key as item_id, sum((it.value->>'qty')::integer) as total
        from orders o, jsonb_each(o.data->'items') it
        where coalesce((o.data->>'prepared')::boolean, false) = false
          and coalesce((o.data->>'paid')::boolean, false) = false
          and (
               (o.data->>'pickupTs') is null
               or (o.data->>'pickupMode') = 'time'
               or (to_timestamp(((o.data->>'pickupTs')::bigint)/1000) at time zone 'Asia/Kuala_Lumpur')::date
                  <= (now() at time zone 'Asia/Kuala_Lumpur')::date
          )
        group by it.key
    ) t;

    -- Availability check: (Stock + Box) − pending demand must cover this
    -- order. Nothing is deducted here (see header comment). A stock qty of
    -- -1 means "no limit set" — skip the check entirely for that item.
    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        select qty into avail_qty from stock where id = item_id;
        if avail_qty is not null and avail_qty <> -1 then
            select coalesce(qty, 0) into box_qty from box_stock where id = item_id;
            pending_qty := coalesce((pending ->> item_id)::integer, 0);
            total_avail := avail_qty + box_qty - pending_qty;
            if total_avail < item_qty then
                return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', greatest(0, total_avail));
            end if;
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


-- ── edit_my_order ────────────────────────────────────────────────────────────
create or replace function edit_my_order(p_order_id bigint, p_token uuid, p_items jsonb, p_note text default null)
returns jsonb
language plpgsql
security definer
as $$
declare
    old_data    jsonb;
    real_items  jsonb;
    totals      jsonb;
    kuah_ratio  integer;
    item_id     text;
    item_qty    integer;
    avail_qty   integer;
    box_qty     integer;
    pending_qty integer;
    total_avail integer;
    pending     jsonb;
begin
    select data into old_data from orders where id = p_order_id and order_token = p_token for update;
    if old_data is null then
        return jsonb_build_object('ok', false, 'reason', 'not_found_or_forbidden');
    end if;

    real_items := _rebuild_order_items(p_items);
    if real_items = '{}'::jsonb then
        return jsonb_build_object('ok', false, 'reason', 'no_items');
    end if;

    -- Pending demand today across every OTHER not-yet-prepared, not-yet-paid
    -- order — excludes this order itself, since we're about to replace its items.
    select coalesce(jsonb_object_agg(t.item_id, t.total), '{}'::jsonb) into pending
    from (
        select it.key as item_id, sum((it.value->>'qty')::integer) as total
        from orders o, jsonb_each(o.data->'items') it
        where o.id <> p_order_id
          and coalesce((o.data->>'prepared')::boolean, false) = false
          and coalesce((o.data->>'paid')::boolean, false) = false
          and (
               (o.data->>'pickupTs') is null
               or (o.data->>'pickupMode') = 'time'
               or (to_timestamp(((o.data->>'pickupTs')::bigint)/1000) at time zone 'Asia/Kuala_Lumpur')::date
                  <= (now() at time zone 'Asia/Kuala_Lumpur')::date
          )
        group by it.key
    ) t;

    -- Availability check on the NEW quantities — same live formula as
    -- place_customer_order. Nothing is deducted/returned (see header comment).
    for item_id, item_qty in
        select key, (value->>'qty')::integer from jsonb_each(real_items)
    loop
        select qty into avail_qty from stock where id = item_id;
        if avail_qty is not null and avail_qty <> -1 then
            select coalesce(qty, 0) into box_qty from box_stock where id = item_id;
            pending_qty := coalesce((pending ->> item_id)::integer, 0);
            total_avail := avail_qty + box_qty - pending_qty;
            if total_avail < item_qty then
                return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', greatest(0, total_avail));
            end if;
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


-- ── cancel_my_order ──────────────────────────────────────────────────────────
-- No stock/box adjustment anymore — placement never deducted anything, so
-- there's nothing to give back. Just deletes the order.
create or replace function cancel_my_order(p_order_id bigint, p_token uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
    old_data jsonb;
begin
    select data into old_data from orders where id = p_order_id and order_token = p_token;
    if old_data is null then
        return jsonb_build_object('ok', false, 'reason', 'not_found_or_forbidden');
    end if;

    delete from orders where id = p_order_id and order_token = p_token;
    return jsonb_build_object('ok', true);
end;
$$;

grant execute on function cancel_my_order(bigint, uuid) to anon;
