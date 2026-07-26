-- Run this ONCE in your Supabase SQL editor, AFTER customer_order_rpc.sql and
-- customer_blocklist.sql (it replaces place_customer_order again, keeping
-- everything from customer_blocklist.sql and adding to it).
--
-- What this closes, in plain terms:
--   1. Price/total/skewerQty/scoops are now calculated HERE, from the live
--      `menu` table and `kuahRatio` setting — never trusted from whatever the
--      customer's browser sends. Before this, opening DevTools and calling
--      place_customer_order directly with forged (very low) prices would
--      have gone straight into the order, and the admin app would display
--      that fake total as real.
--   2. Editing or cancelling an order now requires a random `order_token`
--      that's handed to the customer's browser exactly once, at the moment
--      they place the order — an order ID alone is no longer enough. Before
--      this, calling openEdit(id)/cancelOrder(id)/saveEdit() from the console
--      with a different ID could edit or delete ANY customer's order.
--   3. That token lives in a column ordinary reads can't see (the REVOKE
--      below) — otherwise someone could just ask the API for it directly and
--      the whole scheme would be pointless.
--
-- What this does NOT close yet (that's the "Phase 2" you're planning for your
-- Netlify/fresh-setup move): the `orders`/`menu`/`stock`/`settings` tables
-- are still directly writable by anyone holding the public anon key, since
-- the admin app currently authenticates with that same key and has no
-- separate identity of its own. This migration makes the *intended* path
-- (the RPCs below) correct and safe, and stops the specific tricks described
-- above — but someone bypassing the RPCs entirely and hitting the tables
-- directly still isn't blocked until the admin app has real login and the
-- RLS policies are scoped to it.
--
-- ⚠️ Heads-up on timing: existing/in-flight orders placed BEFORE this
-- migration runs never received a token, so they'll disappear from those
-- customers' "My Order" tab (their browser has no token to prove ownership
-- with). This has NO effect on the admin side — the shop can still see and
-- manage those orders completely normally. Best to run this during a quiet
-- moment with no active pending customer orders, if you can.

alter table orders add column if not exists order_token uuid not null default gen_random_uuid();

-- Hide the token from ordinary reads. The functions below are all
-- `security definer`, so they run as the function owner and can still read
-- and compare it internally — this only blocks it from showing up in a
-- normal `select` a customer (or anyone with the anon key) could run.
revoke select (order_token) on orders from anon;
revoke select (order_token) on orders from authenticated;

-- These two are superseded by edit_my_order/cancel_my_order below (which do
-- the same stock adjustments, but only after verifying the caller's token).
-- Revoking them removes an unused, unauthenticated way to move stock around.
revoke execute on function adjust_stock_diff(jsonb, jsonb) from anon;
revoke execute on function return_customer_stock(jsonb) from anon;


-- ─── Shared helper: rebuild an items map from the live menu ──────────────────
-- Takes the same {"<item_id>": {"qty": N, ...}} shape the app has always
-- sent, and returns it with name/category/price/unitLabel/cost all freshly
-- looked up from `menu` — everything except the item id + qty is ignored,
-- no matter what the caller included. Unknown item ids are dropped rather
-- than trusted.
create or replace function _rebuild_order_items(p_items jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_id  text;
    item_val jsonb;
    item_qty integer;
    result   jsonb := '{}'::jsonb;
    m        record;
begin
    for item_id, item_val in select key, value from jsonb_each(coalesce(p_items, '{}'::jsonb))
    loop
        item_qty := coalesce((item_val->>'qty')::integer, 0);
        if item_qty <= 0 then continue; end if;

        select id, name, category, price, unit_label into m from menu where id = item_id;
        if m.id is null then continue; end if; -- unknown item id — ignore rather than trust it

        result := result || jsonb_build_object(item_id, jsonb_build_object(
            'name',      m.name,
            'category',  m.category,
            'price',     m.price,
            'unitLabel', m.unit_label,
            'qty',       item_qty,
            'cost',      m.price * item_qty
        ));
    end loop;
    return result;
end;
$$;

-- Totals derived the same way order.html has always computed them
-- client-side — just done here now so they can't be spoofed.
create or replace function _order_totals(p_items jsonb, p_kuah_ratio integer)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_key   text;
    item_val   jsonb;
    cat        text;
    qty        integer;
    total_cost numeric := 0;
    skewer_qty integer := 0;
    scoops     integer := 0;
begin
    for item_key, item_val in select key, value from jsonb_each(p_items)
    loop
        cat := item_val->>'category';
        qty := (item_val->>'qty')::integer;
        total_cost := total_cost + coalesce((item_val->>'cost')::numeric, 0);
        if cat in ('skewer', 'no-kuah') then
            skewer_qty := skewer_qty + qty;
        end if;
        if cat = 'skewer' then
            scoops := scoops + ceil(qty::numeric / greatest(p_kuah_ratio, 1));
        elsif cat = 'side' then
            scoops := scoops + qty * 2;
        elsif cat in ('side-1kuah', 'kuah-only') then
            scoops := scoops + qty;
        end if;
    end loop;
    return jsonb_build_object('totalCost', total_cost, 'skewerQty', skewer_qty, 'scoops', scoops);
end;
$$;


-- ─── Place order — now recomputes pricing and issues an ownership token ──────
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


-- ─── Edit order — requires the matching token, recomputes pricing ────────────
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

    -- Check stock for any increases before touching anything
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

    -- Apply the stock diff (skip unlimited items — never turn a -1 into a real number)
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


-- ─── Cancel order — requires the matching token ───────────────────────────────
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


-- ─── Read own orders — only returns rows whose token matches ─────────────────
-- p_orders: jsonb array like [{"id": 123, "token": "..."}, ...]. Rows are
-- only returned where BOTH the id and its token match — holding a token for
-- order 5 doesn't let you peek at order 6 by pairing it with the wrong id.
create or replace function get_my_orders(p_orders jsonb)
returns table(id bigint, data jsonb)
language sql
security definer
as $$
    select o.id, o.data
    from orders o
    join jsonb_to_recordset(p_orders) as req(id bigint, token uuid)
      on o.id = req.id and o.order_token = req.token;
$$;

grant execute on function get_my_orders(jsonb) to anon;
