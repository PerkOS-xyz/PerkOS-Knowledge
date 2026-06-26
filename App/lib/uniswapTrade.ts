/**
 * Uniswap Trading API client — the buyback swap rail.
 *
 * The hosted API (`https://trade-api.gateway.uniswap.org/v1`) quotes + builds
 * classic AMM swaps across v2/v3/v4 on both Base and Celo, so one flow covers
 * Base-v3 + Celo-v4 without us touching the v4 Universal Router / PoolManager.
 *
 * Flow per chain: check_approval (Permit2 for USDC) → quote → swap (ready tx) →
 * the treasury signs + broadcasts (gasful). Here we expose `quoteBuyback` (the
 * read-only dry-run leg) + the approval/swap builders for execution. The
 * treasury private key + on-chain send live in the execute path (Phase C exec),
 * never in this module.
 */
import { NETWORKS, type PayNetwork, usdcBaseUnits } from "./payments";

const TRADE_API = (process.env.UNISWAP_TRADE_API_URL || "https://trade-api.gateway.uniswap.org/v1").replace(/\/+$/, "");

/** $PERKOS token per chain (the buyback's tokenOut). */
export const PERKOS_TOKEN: Record<PayNetwork, string> = {
  base: "0xF714E60f85497D70508F7E356b5DB80e64539BA3",
  celo: "0xb7Ba43fBD4F2E85FCE929f7d4DFE3905Ae846A46",
};

export function uniswapApiKey(): string {
  return (process.env.UNISWAP_API_KEY || "").trim();
}

async function callTradeApi(path: string, body: unknown, timeoutMs = 15000) {
  const key = uniswapApiKey();
  if (!key) return { httpOk: false, status: 0, data: { errorCode: "uniswap_api_key_missing" } as Record<string, unknown> };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${TRADE_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { httpOk: res.ok, status: res.status, data };
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e instanceof Error ? e.message : "trade_api_error";
    return { httpOk: false, status: 0, data: { errorCode: reason } as Record<string, unknown> };
  } finally {
    clearTimeout(t);
  }
}

export type BuybackQuote = {
  ok: boolean;
  chain: PayNetwork;
  amountInUsdc: number;
  /** $PERKOS out, base units (18-dec) as a string, and a human float. */
  amountOutPerkos: string | null;
  amountOutPerkosFloat: number | null;
  /** Echoed for the swap step. */
  quote: unknown;
  error?: string;
};

/**
 * DRY-RUN: quote `amountUsdc` USDC → $PERKOS on `chain`, CLASSIC routing only
 * (no gasless UniswapX). Read-only — no approval, no trade. `swapper` is the
 * treasury that would execute (0x3f0D).
 */
export async function quoteBuyback(opts: {
  chain: PayNetwork;
  amountUsdc: number;
  swapper: string;
}): Promise<BuybackQuote> {
  const n = NETWORKS[opts.chain];
  const base = { ok: false as const, chain: opts.chain, amountInUsdc: opts.amountUsdc, amountOutPerkos: null, amountOutPerkosFloat: null, quote: null };
  if (!(opts.amountUsdc > 0)) return { ...base, error: "amount_must_be_positive" };

  const { httpOk, data } = await callTradeApi("/quote", {
    type: "EXACT_INPUT",
    amount: usdcBaseUnits(opts.amountUsdc, opts.chain),
    tokenInChainId: n.chainId,
    tokenOutChainId: n.chainId,
    tokenIn: n.usdc,
    tokenOut: PERKOS_TOKEN[opts.chain],
    swapper: opts.swapper,
    routing: "CLASSIC",
  });

  if (!httpOk) {
    const err = (data.errorCode as string) || (data.detail as string) || (data.message as string) || "quote_failed";
    return { ...base, error: err };
  }
  // The CLASSIC quote nests the output under `quote.output.amount` (18-dec base units).
  const q = (data.quote ?? data) as Record<string, unknown>;
  const output = (q.output ?? {}) as Record<string, unknown>;
  const outRaw =
    (output.amount as string) ??
    (q.amountOut as string) ??
    (q.quote as string) ??
    null;
  const outFloat = outRaw != null ? Number(outRaw) / 1e18 : null;
  return {
    ok: true,
    chain: opts.chain,
    amountInUsdc: opts.amountUsdc,
    amountOutPerkos: outRaw,
    amountOutPerkosFloat: outFloat,
    quote: data,
  };
}
