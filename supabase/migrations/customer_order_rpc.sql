-- Run this ONCE in your Supabase SQL editor
-- Atomic order insert with stock check — prevents race conditions

create or replace function place_customer_order(order_data jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
    item_id   text;
    item_qty  integer;
    avail_qty integer;
    new_id    bigint;
    items     jsonb;
begin
    items := order_data -> 'items';

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

-- Stock adjustment for customer edits
create or replace function adjust_stock_diff(old_items jsonb, new_items jsonb)
returns void
language plpgsql
security definer
as $$
declare
    item_id  text;
    old_qty  integer;
    new_qty  integer;
    diff     integer;
begin
    for item_id in select distinct key from (
        select key from jsonb_each(old_items)
        union select key from jsonb_each(new_items)
    ) t
    loop
        old_qty := coalesce((old_items -> item_id ->> 'qty')::integer, 0);
        new_qty := coalesce((new_items -> item_id ->> 'qty')::integer, 0);
        diff    := new_qty - old_qty;
        if diff <> 0 then
            update stock
            set qty = greatest(0, qty - diff),
                updated_at = now()
            where id = item_id and qty is not null;
        end if;
    end loop;
end;
$$;

grant execute on function adjust_stock_diff(jsonb, jsonb) to anon;

-- Return stock when customer cancels their order
create or replace function return_customer_stock(order_items jsonb)
returns void
language plpgsql
security definer
as $$
declare
    item_id  text;
    item_qty integer;
begin
    for item_id, item_qty in
        select key, (value->>'qty')::integer
        from jsonb_each(order_items)
        where (value->>'qty')::integer > 0
    loop
        update stock
        set qty = qty + item_qty,
            updated_at = now()
        where id = item_id
          and qty is not null;
    end loop;
end;
$$;

grant execute on function return_customer_stock(jsonb) to anon;
