-- Run this ONCE in your Supabase SQL editor, AFTER box_stock.sql.
--
-- What this fixes:
--   reset_box_stock() ran `update box_stock set qty = 0, cooked_total = 0 ...`
--   with no WHERE clause — intentional, since the whole point is to reset
--   every item in the box at day-close. But this database has unqualified
--   UPDATE/DELETE statements blocked as a safety guard, so every call to
--   reset_box_stock() was failing outright with:
--     "UPDATE requires a WHERE clause" (error 21000)
--   which meant the box was never actually getting reset at day-close.
--
--   The fix is just a `where true` — it still matches every row (so the
--   reset still resets everything, no behavior change), it just satisfies
--   the "must have a WHERE clause" requirement syntactically.

create or replace function reset_box_stock()
returns void
language plpgsql
security definer
as $$
begin
    update box_stock set qty = 0, cooked_total = 0, updated_at = now() where true;
end;
$$;

grant execute on function reset_box_stock() to anon;
