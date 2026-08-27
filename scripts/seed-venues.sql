-- Known real swap venues on 4663 (idempotent — applied automatically by stack up).
-- These power candle indexing AND zap venue discovery; rows survive db rebuilds by
-- living here instead of ad-hoc INSERTs. Add new discoveries to this file.

-- CASHCAT/WETH deep v4 hookless pool (fee 2888, tickSpacing 1) — the incumbent venue
INSERT OR IGNORE INTO pools (pool_id, currency0, currency1, fee, tick_spacing, hooks, watched)
VALUES (
  '0xfb4f9cf463af813633e533f7e81cfb95cea80422495d02ac3552d92ed2786e88',
  '0x020bfC650A365f8BB26819deAAbF3E21291018b4',
  '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  2888, 1, '0x0000000000000000000000000000000000000000', 1
);
