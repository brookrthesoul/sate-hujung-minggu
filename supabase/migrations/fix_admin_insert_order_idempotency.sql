-- Run this ONCE in your Supabase SQL editor, AFTER admin_insert_order_with_id.sql
-- (this replaces that function with a corrected version).
--
-- What this fixes:
--   The original version of this function had no way to tell the difference
--   between two very different situations that both look like "id already
--   taken":
--     (a) a GENUINE collision — a different, unrelated order already has
--         this number (another device predicted the same number, or an
--         online order landed on it in the meantime), or
--     (b) a RETRY of the exact same request — the insert actually
--         succeeded moments ago, but the client never received the
--         confirmation (e.g. the connection was still flaky right at the
--         moment a phone flipped from offline to online) and tried again.
--
--   Both looked identical to the function — "unique_violation, fall back
--   to a new auto-assigned id" — which is correct for (a) but WRONG for
--   (b): it created a second, duplicate row for the same order. Each
--   device would then be looking at a different row for what they thought
--   was the same order — explaining why a delete/undo done on the device
--   that created the order offline would never show up on any other
--   device, even after a hard refresh (the other device's row was never
--   touched, because it was a genuinely different database row).
--
--   The fix: before falling back, check whether the existing row at that
--   id has the same deviceId + createdAt as the incoming request — that
--   combination uniquely identifies a single real order-creation event.
--   If it matches, this is a retry — just return the existing row as-is
--   instead of creating a duplicate. If it doesn't match (or the existing
--   row predates this device-id tracking), fall back to auto-assigning a
--   new id exactly as before.

create or replace function admin_insert_order_with_id(p_id bigint, p_data jsonb, p_updated_ms bigint)
returns jsonb
language plpgsql
security definer
as $$
declare
    new_row  orders;
    existing orders;
begin
    select * into existing from orders where id = p_id;

    if found
       and existing.data->>'deviceId'  is not null
       and existing.data->>'deviceId'  = p_data->>'deviceId'
       and existing.data->>'createdAt' is not null
       and existing.data->>'createdAt' = p_data->>'createdAt' then
        -- Same device, same creation timestamp = this is a retry of a
        -- request that actually succeeded already. Return the existing
        -- row rather than creating a duplicate.
        return jsonb_build_object('id', existing.id, 'data', existing.data, 'updated_ms', existing.updated_ms);
    end if;

    begin
        insert into orders (id, data, updated_ms)
        values (p_id, p_data, p_updated_ms)
        returning * into new_row;
    exception when unique_violation then
        -- Predicted id genuinely taken by a different order — fall back to
        -- a normal auto-assigned id rather than losing the order.
        insert into orders (data, updated_ms)
        values (p_data, p_updated_ms)
        returning * into new_row;
    end;

    -- Keep the identity sequence ahead of the highest id actually in use,
    -- whether we used the predicted id or the fallback above, so the next
    -- automatic insert (customer order, another admin device, etc.) never
    -- collides with it.
    perform setval('orders_id_seq', (select max(id) from orders));

    return jsonb_build_object('id', new_row.id, 'data', new_row.data, 'updated_ms', new_row.updated_ms);
end;
$$;

grant execute on function admin_insert_order_with_id(bigint, jsonb, bigint) to anon;
