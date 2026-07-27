-- ============================================================================
-- BOX STOCK — "prepared items box" feature
-- Run this ONCE in your Supabase SQL editor (Dashboard → SQL Editor → paste → Run)
-- ============================================================================
--
-- WHAT THIS IS (read this before touching the RPC below):
-- The Box is a buffer of already-cooked skewer/custom-unit items sitting
-- ready to pack, for walk-in customers who don't want to wait. It is
-- SEPARATE from the raw-ingredient `stock` table (that one tracks how much
-- raw chicken/beef/etc is left to cook AT ALL; this one tracks how much is
-- already cooked and sitting in the box RIGHT NOW).
--
-- Two numbers per menu item, both live in this one table:
--   qty          – physical box quantity right now, ready to pack. Goes down
--                  automatically when an order draws from it (see
--                  place_customer_order below), or manually when staff grab
--                  items without a formal order. Goes up when staff add a
--                  freshly-cooked batch.
--   cooked_total – running total of everything cooked into the box TODAY.
--                  Only ever goes up (except at day-close reset). This is
--                  what the admin app's "still need to cook" number is based
--                  on: total ordered − cooked_total. It deliberately does
--                  NOT go down when the box gets drawn on by an order — see
--                  the long comment on place_customer_order for why.
--
-- EASY TO ADJUST LATER: if you ever want a change that only affects the
-- physical box count and should NEVER move the kitchen's "still need to
-- cook" number, adjust `qty` only and leave `cooked_total` alone (this is
-- exactly what adjust_box_stock(id, qty_delta, 0) does).
-- ============================================================================

create table if not exists box_stock (
  id           text primary key,            -- menu item id, same id space as `stock`
  qty          integer not null default 0,
  cooked_total integer not null default 0,
  updated_at   timestamptz default now()
);

alter table box_stock enable row level security;
create policy "anon can manage box_stock" on box_stock
  for all using (true) with check (true);

-- Realtime, so every device (admin dashboard(s) + customer order page) sees
-- box changes instantly without a manual refresh.
alter publication supabase_realtime add table box_stock;


-- ── adjust_box_stock ─────────────────────────────────────────────────────────
-- Atomically bump one item's box numbers up or down. Deltas can be negative;
-- both qty and cooked_total are clamped at 0 so they can never go negative.
-- Upserts the row if this item has never had a box entry before.
create or replace function adjust_box_stock(p_id text, p_qty_delta integer, p_cooked_delta integer default 0)
returns void
language plpgsql
security definer
as $$
begin
    insert into box_stock (id, qty, cooked_total)
    values (p_id, greatest(0, p_qty_delta), greatest(0, p_cooked_delta))
    on conflict (id) do update
      set qty          = greatest(0, box_stock.qty + p_qty_delta),
          cooked_total  = greatest(0, box_stock.cooked_total + p_cooked_delta),
          updated_at    = now();
end;
$$;

grant execute on function adjust_box_stock(text, integer, integer) to anon;


-- ── reset_box_stock ──────────────────────────────────────────────────────────
-- Day-close reset — empties the box and clears today's cooked_total for
-- every item. The admin app calls this once automatically when it detects a
-- new day has started (see autoClosePreviousDay() in orders.js).
create or replace function reset_box_stock()
returns void
language plpgsql
security definer
as $$
begin
    update box_stock set qty = 0, cooked_total = 0, updated_at = now();
end;
$$;

grant execute on function reset_box_stock() to anon;


-- ── place_customer_order (REPLACES the version in customer_order_rpc.sql) ──
-- Now Box-aware. For every ordered item:
--   1. Take as much as possible from box_stock.qty first (already cooked,
--      sitting ready — no fresh cooking or raw stock needed for this part).
--   2. Whatever's left over (the SHORTFALL) is checked/deducted against the
--      raw-ingredient `stock` table — same as before, just against the
--      smaller shortfall number instead of the full ordered quantity.
--
-- cooked_total is untouched here on purpose. It only ever increases when
-- someone explicitly adds a freshly-cooked batch to the box (via
-- adjust_box_stock from the app) — that way the kitchen's "still need to
-- cook" total (ordered − cooked_total) stays correct no matter how the box's
-- live qty gets drawn down by individual orders throughout the day.
--
-- KNOWN LIMITATION (documented, not yet handled): if a customer edits or
-- cancels an order after placing it, adjust_stock_diff / return_customer_stock
-- (below, unchanged from before) only return items to the raw `stock` table,
-- not back into the Box — because we don't currently record how much of an
-- order came from the Box vs was freshly cooked. Low-frequency edge case;
-- flagged here so it's easy to revisit later if it turns out to matter.
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
    items      jsonb;
    shortfalls jsonb := '{}'::jsonb; -- item_id -> shortfall qty (post-box)
begin
    items := order_data -> 'items';

    -- Pass 1: lock box rows, work out how much of each item's demand the box
    -- can cover right now, and how much is left over (the shortfall).
    for item_id, item_qty in
        select key, (value->>'qty')::integer
        from jsonb_each(items)
        where (value->>'qty')::integer > 0
    loop
        select qty into box_qty from box_stock where id = item_id for update;
        box_qty    := coalesce(box_qty, 0);
        box_used   := least(box_qty, item_qty);
        shortfall  := item_qty - box_used;
        shortfalls := shortfalls || jsonb_build_object(item_id, shortfall);
    end loop;

    -- Pass 2: lock stock rows and check availability against the SHORTFALL
    -- only — the box-covered portion doesn't need any more raw stock right now.
    for item_id in select key from jsonb_each(shortfalls)
    loop
        shortfall := (shortfalls ->> item_id)::integer;
        if shortfall > 0 then
            select qty into avail_qty from stock where id = item_id for update;
            if avail_qty is not null and avail_qty < shortfall then
                if avail_qty = 0 then
                    return jsonb_build_object('ok', false, 'reason', 'out_of_stock', 'item', item_id);
                else
                    return jsonb_build_object('ok', false, 'reason', 'insufficient', 'item', item_id, 'available', avail_qty);
                end if;
            end if;
        end if;
    end loop;

    -- Pass 3: everything checks out — deduct the box (qty only — cooked_total
    -- is deliberately left alone, see header comment) and deduct raw stock
    -- for the shortfall only.
    for item_id, item_qty in
        select key, (value->>'qty')::integer
        from jsonb_each(items)
        where (value->>'qty')::integer > 0
    loop
        shortfall := (shortfalls ->> item_id)::integer;
        box_used  := item_qty - shortfall;
        if box_used > 0 then
            update box_stock set qty = greatest(0, qty - box_used), updated_at = now()
            where id = item_id;
        end if;
        if shortfall > 0 then
            update stock set qty = greatest(0, qty - shortfall), updated_at = now()
            where id = item_id and qty is not null;
        end if;
    end loop;

    -- Insert order — unchanged. Full quantities are stored; Box bookkeeping
    -- above is purely internal and never affects what the customer ordered.
    insert into orders (data, updated_ms)
    values (order_data, extract(epoch from now()) * 1000)
    returning id into new_id;

    return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

grant execute on function place_customer_order(jsonb) to anon;
