-- Multi-manager support: record which FriarPositionManager each position lives on.
--
-- schema.sql uses CREATE TABLE IF NOT EXISTS, so it cannot add a column to an existing
-- table — this runs ONCE per database, by hand:
--
--   local:  wrangler d1 execute friar --local --persist-to ../../.wrangler-persist \
--             --file migrations/2026-07-27-positions-manager.sql
--   remote: wrangler d1 execute friar --remote \
--             --file migrations/2026-07-27-positions-manager.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; re-running this errors with "duplicate column
-- name: manager", which is harmless and means it was already applied.

ALTER TABLE positions ADD COLUMN manager TEXT;

-- Everything recorded before this migration came from the tiered-fee manager, which was
-- the only deployment the indexer ever watched.
UPDATE positions SET manager = '0x0e9064622c6AD90d9ADfFcd1E203df52cC870cb3' WHERE manager IS NULL;

CREATE INDEX IF NOT EXISTS idx_positions_manager ON positions(manager);
