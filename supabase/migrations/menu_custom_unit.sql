-- Run this ONCE if you already ran menu_table.sql before this update.
-- (Skip this file entirely on a brand-new setup — menu_table.sql already
-- includes this column for fresh installs.)
--
-- Adds support for a "Custom unit" menu category — for items that don't fit
-- the skewer/kuah-kacang system, e.g. a bakery selling cake by the slice or
-- pastries by the piece. Each item using this category stores its own unit
-- label here (e.g. "slice", "pcs", "whole").

alter table menu add column if not exists unit_label text;
