/**
 * x402 payment rail — routes consumer USDC payments through PerkOS Stack
 * (stack.perkos.xyz), the standards-compliant x402 facilitator. Stack verifies +
 * settles the on-chain USDC transfer (EIP-3009 "exact" scheme) on the chosen
 * network; we then credit the payer's prepaid balance. This is the on-chain
 * deposit path the credit model was missing.
 *
 * Networks: Base + Celo mainnet, both USDC (6-dec). The asset/payTo go in the
 * x402 paymentRequirements; the payer signs a gasless authorization that Stack
 * settles.
 *
 * Facilitator endpoints are the x402-standard `/verify` + `/settle` (NOT
 * `/api/v2/x402/*` — that route's request schema validates x402Version as a
 * string while its version check compares it as a number, so it rejects every
 * payload with "expected string, received number"; `/verify` + `/settle` accept
 * the standard `{ x402Version: 1, paymentPayload, paymentRequirements }`).
 */
import { parseUnits } from "viem";

export type PayNetwork = "base" | "celo";

// `name`/`version` are the on-chain EIP-712 domain of each USDC (verified live):
// Base USDC = "USD Coin"/"2", Celo USDC = "USDC"/"2". They MUST match the token
// contract exactly — the payer signs the EIP-3009 authorization against this
// domain and the facilitator verifies it, so a wrong name = invalid signature.
export const NETWORKS: Record<
  PayNetwork,
  { chainId: number; usdc: string; decimals: number; x402: string; name: string; version: string }
> = {
  base: { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, x402: "base", name: "USD Coin", version: "2" },
  celo: { chainId: 42220, usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, x402: "celo", name: "USDC", version: "2" },
};

export function isPayNetwork(n: unknown): n is PayNetwork {
  return n === "base" || n === "celo";
}

/** Map an x402 network name (or a chainId) back to our key. */
export function networkKeyFor(name: unknown): PayNetwork | null {
  const s = String(name ?? "").toLowerCase();
  if (s === "base" || s === "8453") return "base";
  if (s === "celo" || s === "42220") return "celo";
  return null;
}

export function facilitatorBase(): string {
  return (process.env.KNOWLEDGE_X402_FACILITATOR_URL || "https://stack.perkos.xyz").replace(/\/$/, "");
}

export function treasuryPayTo(): string {
  return (process.env.KNOWLEDGE_X402_PAY_TO || process.env.KNOWLEDGE_TREASURY_ADDRESS || "").trim();
}

/** Decimal USDC (e.g. 1.5) → base-unit string for a network. */
export function usdcBaseUnits(amount: number, net: PayNetwork): string {
  if (!(amount > 0)) return "0";
  return parseUnits(amount.toFixed(NETWORKS[net].decimals), NETWORKS[net].decimals).toString();
}

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
};

/** Build x402 paymentRequirements for a USDC deposit on a network. */
export function buildPaymentRequirements(net: PayNetwork, amount: number, resource: string): PaymentRequirements {
  const n = NETWORKS[net];
  return {
    scheme: "exact",
    network: n.x402,
    maxAmountRequired: usdcBaseUnits(amount, net),
    resource,
    description: `PerkOS Knowledge deposit — ${amount} USDC on ${net}`,
    mimeType: "application/json",
    payTo: treasuryPayTo(),
    maxTimeoutSeconds: 120,
    asset: n.usdc,
    extra: { name: n.name, version: n.version },
  };
}

/** Decode the base64 `X-PAYMENT` header into the x402 paymentPayload. */
export function decodePaymentHeader(header: string | null): Record<string, unknown> | null {
  if (!header || !header.trim()) return null;
  try {
    return JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8"));
  } catch {
    try {
      return JSON.parse(header);
    } catch {
      return null;
    }
  }
}

async function callFacilitator(path: string, payload: unknown, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${facilitatorBase()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { httpOk: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

/** Verify (no settlement) a payment via Stack. */
export async function verifyViaStack(paymentPayload: unknown, paymentRequirements: unknown) {
  const { httpOk, status, data } = await callFacilitator("/verify", {
    x402Version: 1,
    paymentPayload,
    paymentRequirements,
  });
  return {
    valid: httpOk && data.isValid === true,
    payer: (data.payer as string) ?? null,
    reason: (data.invalidReason as string) ?? (httpOk ? null : `HTTP ${status}`),
  };
}

/** Verify + settle a payment on-chain via Stack. `status`/`raw` are returned for
 *  error logging (the full facilitator response when a settle is rejected). */
export async function settleViaStack(paymentPayload: unknown, paymentRequirements: unknown) {
  const { httpOk, status, data } = await callFacilitator("/settle", {
    x402Version: 1,
    paymentPayload,
    paymentRequirements,
  });
  return {
    ok: httpOk && data.success === true,
    transaction: (data.transaction as string) ?? null,
    payer: (data.payer as string) ?? null,
    network: (data.network as string) ?? null,
    error:
      (data.errorReason as string) ??
      (data.error as string) ??
      (data.message as string) ??
      (httpOk ? null : `HTTP ${status}`),
    status,
    raw: data,
  };
}
