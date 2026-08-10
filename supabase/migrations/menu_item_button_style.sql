-- Run this ONCE in your Supabase SQL editor if you already ran menu_table.sql
-- before this update. (Skip this file entirely on a brand-new setup if you
-- copy the updated menu_table.sql schema instead.)
--
-- Adds per-item button styling to the New Order menu buttons:
--   bg_image   — an uploaded background image, stored as a resized/compressed
--                data URL (kept small client-side before upload, so this
--                stays well within normal text-column limits)
--   bg_color   — a solid background colour fallback (hex), used when no
--                image is set
--   text_color — an override for the item name/price text colour, so it
--                stays readable against a custom background/image

alter table menu add column if not exists bg_image   text;
alter table menu add column if not exists bg_color   text;
alter table menu add column if not exists text_color text;
