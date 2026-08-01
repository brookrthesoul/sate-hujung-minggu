-- Run this ONCE in your Supabase SQL editor, AFTER orders_table.sql.
--
-- What this is for:
--   When the admin app creates a new order while offline, it can't ask
--   Supabase for the "real" next order number (that's what causes the
--   card/receipt number to temporarily show a huge placeholder number
--   until the connection comes back and the order gets swapped for its
--   real id). This RPC lets the app instead PREDICT the next number
--   locally (based on the highest order id it has seen) and hand that
--   same number straight to the customer's receipt — then, once back
--   online, ask Supabase to actually save the order under that exact id.
--
--   Most of the time (single device, or no other order landed in the
--   gap) this succeeds and the printed number matches the real one
--   perfectly. If two devices happened to predict the same number while
--   both offline — or an online order took that number in the meantime —
--   this falls back to a normal auto-assigned id instead of failing, and
--   the app will flag that specific order so you know to double check
--   the number on that one receipt.
--
--   Either way, it re-syncs the identity sequence afterward so future
--   normal orders (from the customer app or any other device) never
--   collide with a manually-chosen id.

create or replace function admin_insert_order_with_id(p_id bigint, p_data jsonb, p_updated_ms bigint)
returns jsonb
language plpgsql
security definer
as $$
declare
    new_row orders;
begin
    begin
        insert into orders (id, data, updated_ms)
        values (p_id, p_data, p_updated_ms)
        returning * into new_row;
    exception when unique_violation then
        -- Predicted id got taken first (rare race) — fall back to a normal
        -- auto-assigned id rather than losing the order.
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
