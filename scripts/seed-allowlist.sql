-- Beta allowlist (idempotent — applied on every stack up; for production:
-- wrangler d1 execute friar --remote --file scripts/seed-allowlist.sql)
INSERT OR IGNORE INTO allowlist (address, label) VALUES
  ('0x4b7b481d3e6c559438784c60295265a9d1ca9ae9', 'taylor'),
  ('0xea41b6d65d74742cbf52c29e200e5ae9fae73058', 'operator'),
  ('0x65d9120fadb26dc31ad0200ab0ad38daae5dd2d7', 'tester-1');
