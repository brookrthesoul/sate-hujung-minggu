-- Run this ONCE in your Supabase SQL editor, AFTER
-- fix_admin_insert_order_idempotency.sql (it replaces that function again).
--
-- What this fixes:
--   The previous version only checked for a "retry" at the SAME id it was
--   asked to use, and only when the existing row carried a deviceId. Admin
--   orders never carried a deviceId at all (only customer orders did), so
--   for admin orders that check could never match and every retry created a
--   DUPLICATE order — verified live: the same request sent twice produced
--   order #299 and a second copy as #300.
--
--   Two real-world situations hit this:
--     1. The phone flips from offline to online, the upload actually
--        succeeds, but the confirmation never arrives — the app retries.
--     2. The predicted number was taken in the meantime, so the order is
--        re-inserted under a NEW auto id; a later retry then no longer
--        matches anything at the predicted id.
--
--   The fix: look the order up by its creation FINGERPRINT
--   (data->>'deviceId' + data->>'createdAt') anywhere in the table, not just
--   at the requested id. That pair identifies one real order-creation event,
--   so a retry is always recognised and the existing row is returned
--   unchanged. Genuine collisions between two different orders still fall
--   back to a fresh auto-assigned id exactly as before.
--
--   Pair this with the app update that stamps deviceId on every admin order.

create index if not exists orders_fingerprint_idx
    on orders (((data ->> 'deviceId')), ((data ->> 'createdAt')));

create or replace function admin_insert_order_with_id(p_id bigint, p_data jsonb, p_updated_ms bigint)
returns jsonb
language plpgsql
security definer
as $$
declare
    new_row  orders;
    existing orders;
begin
    -- 1. Retry detection by fingerprint (works no matter which id the order
    --    actually ended up with).
    if p_data ->> 'deviceId' is not null and p_data ->> 'createdAt' is not null then
        select * into existing
        from orders
        where data ->> 'deviceId'  = p_data ->> 'deviceId'
          and data ->> 'createdAt' = p_data ->> 'createdAt'
        order by id
        limit 1;

        if found then
            return jsonb_build_object('id', existing.id, 'data', existing.data, 'updated_ms', existing.updated_ms);
        end if;
    end if;

    -- 2. Legacy fallback: same id, same device+createdAt (rows written before
    --    the fingerprint index existed).
    select * into existing from orders where id = p_id;
    if found
       and existing.data ->> 'deviceId'  is not null
       and existing.data ->> 'deviceId'  = p_data ->> 'deviceId'
       and existing.data ->> 'createdAt' is not null
       and existing.data ->> 'createdAt' = p_data ->> 'createdAt' then
        return jsonb_build_object('id', existing.id, 'data', existing.data, 'updated_ms', existing.updated_ms);
    end if;

    -- 3. Normal path: keep the number printed on the receipt when it's free.
    begin
        insert into orders (id, data, updated_ms)
        values (p_id, p_data, p_updated_ms)
        returning * into new_row;
    exception when unique_violation then
        -- Number genuinely taken by a DIFFERENT order — never overwrite it;
        -- take a fresh auto id instead so no order is lost.
        insert into orders (data, updated_ms)
        values (p_data, p_updated_ms)
        returning * into new_row;
    end;

    -- Keep the identity sequence ahead of the highest id in use so future
    -- automatic inserts (customer orders, other devices) never collide.
    perform setval('orders_id_seq', greatest((select max(id) from orders), 1));

    return jsonb_build_object('id', new_row.id, 'data', new_row.data, 'updated_ms', new_row.updated_ms);
end;
$$;

grant execute on function admin_insert_order_with_id(bigint, jsonb, bigint) to anon;
