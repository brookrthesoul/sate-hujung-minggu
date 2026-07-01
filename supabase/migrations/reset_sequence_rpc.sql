-- Run this ONCE in your Supabase SQL editor to enable the order number reset feature.
-- Go to: Supabase Dashboard → SQL Editor → paste this → Run

create or replace function reset_orders_sequence()
returns void
language plpgsql
security definer
as $$
begin
  -- Reset the orders id sequence back to 1
  -- This makes the next inserted order get id = 1
  alter sequence orders_id_seq restart with 1;
end;
$$;

-- Allow the anon key to call this function
grant execute on function reset_orders_sequence() to anon;
