# friar-mcp

Remote **MCP server** for Friar on Robinhood Chain (4663), at **`https://mcp.friar.fi/mcp`**
(Streamable HTTP; legacy SSE at `/sse`). It gives any MCP-speaking agent — Claude,
ChatGPT, or an agent wired into Robinhood's agentic platform — the full Friar surface:

- **Intelligence**: pool board, hot-token discovery, live dynamic-fee gauge (read from
  the hook's `previewFee` — the widget static-fee venues can't show), candles, token
  safety screen, positions with fees-vs-inventory PnL decomposition, and a trustless
  chain-direct position view that works even if Friar's backend is down.
- **Actions**: position planning plus **unsigned transaction builders** for
  open/openNew, increase, decrease, close, collect (approvals included). Every build
  tool returns `{ to, data, value, chainId }` payloads — **the agent's wallet signs;
  this server never touches keys**. That's the whole trust model, and it's why it
  composes with agent-wallet platforms: the wallet remains the only gate.

No auth, same doctrine as the REST API: everything served is public-chain-derived or
pure encoding.

## Tools

| Tool | What |
|---|---|
| `friar_chain_info` | chain id, addresses, quote tokens (WETH/USDG), fee model |
| `friar_list_pools` | indexed pools + 24h volume/swaps/last price |
| `friar_hot_tokens` | discovery board, annotated with Friar-pool presence |
| `friar_pool_state` | live price/tick + current dynamic fee from the hook |
| `friar_candles` | OHLCV (v4 pools and incumbent v3 venues) |
| `friar_token_safety` | Blockaid+GoPlus screen; `block` = do not LP |
| `friar_positions` / `friar_position` | positions + PnL decomposition (owner-keyed) |
| `friar_position_onchain` | trustless record + mark, RPC only |
| `friar_plan_open` | shape → bins → exact deposits (preview, no txs) |
| `friar_build_open` | approvals + open/openNew, unsigned (refuses safety-blocked tokens) |
| `friar_build_increase` / `_decrease` / `_close` / `_collect` | manage, unsigned |

## Connect

Claude Code: `claude mcp add --transport http friar https://mcp.friar.fi/mcp`

Claude Desktop / other clients: add a remote MCP server with URL
`https://mcp.friar.fi/mcp` (Streamable HTTP, no auth).

Agents on Robinhood's agentic platform connect to Robinhood's own MCP servers for
wallet/trading; add this server alongside — Friar supplies the LP intelligence and
unsigned transactions, the platform wallet signs on 4663.

## Dev

```bash
npm run dev -w @friar/mcp   # wrangler dev on :8791 (shares .wrangler-persist)
npm run deploy mcp          # → mcp.friar.fi (from repo root; scripts/deploy.mjs)
```

Notes: `wrangler.jsonc` aliases the `agents` package's optional `ai` import to a stub
(`src/stub-ai.ts`) — we never use its AI-SDK client paths. The Durable Object
(`FriarMCP`) exists for MCP session transport; all tool state is stateless reads.
