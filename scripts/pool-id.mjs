// Compute a v4 PoolId from a PoolKey JSON — for hand-adding pools to the watch list.
// Usage: node scripts/pool-id.mjs '{"currency0":"0x..","currency1":"0x..","fee":8388608,"tickSpacing":100,"hooks":"0x.."}'
import { poolId } from "../packages/chain/src/poolKey.ts";

const key = JSON.parse(process.argv[2] ?? "null");
if (!key) {
  console.error("usage: node scripts/pool-id.mjs '<poolKey json>'");
  process.exit(1);
}
const id = poolId(key);
console.log(id);
console.log(
  `\nINSERT INTO pools (pool_id, currency0, currency1, fee, tick_spacing, hooks, watched) VALUES ('${id}', '${key.currency0}', '${key.currency1}', ${key.fee}, ${key.tickSpacing}, '${key.hooks}', 1);`,
);
