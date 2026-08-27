// Typed client for the public Friar REST API (apps/api). All reads are keyed by
// address — no auth. Everything here is recomputable from the chain; the API is the
// fast path, the chain reads in reads.ts are the trustless path.
import type {
  ApiCandle,
  ApiPool,
  ApiPosition,
  ApiPositionDetail,
  ApiSnapshot,
  ApiTokenBoardEntry,
  ApiTokenSafety,
} from "./types.ts";

// Runtime-agnostic like @friar/chain (no DOM/workers libs): declare the one global we use.
declare const fetch: (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export const DEFAULT_API_URL = "https://api.friar.fi";

export class FriarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    body: string,
  ) {
    super(`friar-api ${status} on ${url}: ${body.slice(0, 200)}`);
    this.name = "FriarApiError";
  }
}

export class FriarApi {
  constructor(private readonly baseUrl: string = DEFAULT_API_URL) {}

  private async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const qs = Object.entries(params ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new FriarApiError(res.status, url, await res.text());
    return (await res.json()) as T;
  }

  async pools(): Promise<ApiPool[]> {
    return (await this.get<{ pools: ApiPool[] }>("/pools")).pools;
  }

  /** Dexscreener hot-token discovery board, annotated with Friar pool presence. */
  async tokens(): Promise<ApiTokenBoardEntry[]> {
    return (await this.get<{ tokens: ApiTokenBoardEntry[] }>("/tokens")).tokens;
  }

  /** OHLCV; `id` is a v4 poolId or an incumbent v3 pool address. Interval in seconds. */
  async candles(id: string, opts?: { interval?: number; from?: number; to?: number }): Promise<ApiCandle[]> {
    const r = await this.get<{ candles: ApiCandle[] }>(`/pools/${id}/candles`, {
      interval: opts?.interval,
      from: opts?.from,
      to: opts?.to,
    });
    return r.candles;
  }

  async positions(owner: string): Promise<ApiPosition[]> {
    return (await this.get<{ positions: ApiPosition[] }>(`/positions/${owner}`)).positions;
  }

  /** Detail reads are owner-keyed: ids are enumerable, so the owner must match. */
  async position(id: number | bigint, owner: string): Promise<ApiPositionDetail> {
    return this.get<ApiPositionDetail>(`/position/${id}`, { owner });
  }

  async positionSnapshots(
    id: number | bigint,
    owner: string,
    opts?: { from?: number; to?: number },
  ): Promise<ApiSnapshot[]> {
    const r = await this.get<{ snapshots: ApiSnapshot[] }>(`/position/${id}/snapshots`, {
      owner,
      from: opts?.from,
      to: opts?.to,
    });
    return r.snapshots;
  }

  async portfolioHistory(
    owner: string,
    opts?: { from?: number; to?: number },
  ): Promise<Array<{ ts: number; valueQuote: string }>> {
    const r = await this.get<{ history: Array<{ ts: number; valueQuote: string }> }>(
      `/portfolio/${owner}/history`,
      { from: opts?.from, to: opts?.to },
    );
    return r.history;
  }

  /** Malicious-token screen (Blockaid + GoPlus, 6h cache). Empty sources = unchecked, not clean. */
  async tokenSafety(address: string): Promise<ApiTokenSafety> {
    return this.get<ApiTokenSafety>(`/token/${address.toLowerCase()}/safety`);
  }

  async allowed(address: string): Promise<boolean> {
    return (await this.get<{ allowed: boolean }>(`/allowed/${address.toLowerCase()}`)).allowed;
  }

  async usdPerWeth(): Promise<number | null> {
    return (await this.get<{ usdPerWeth: number | null }>("/rate")).usdPerWeth;
  }
}
