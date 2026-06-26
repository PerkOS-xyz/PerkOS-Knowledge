#!/usr/bin/env node
/**
 * Month-end $PERKOS usage-drop orchestrator — ONE CHAIN per run.
 *
 * Chains the already-validated legs: read the month's budget → market-buy
 * $PERKOS (Uniswap Trading API, treasury signs) → distribute (platform 40% kept,
 * 60% to users by usage → token_rewards) → build the Merkle root → fund the
 * vault with the user $PERKOS → post the root. Users then claim from the
 * dashboard.
 *
 * Run from the App dir (needs viem in App/node_modules):
 *   node scripts/monthly-drop.mjs --chain=base            # DRY-RUN (default)
 *   node scripts/monthly-drop.mjs --chain=celo --month=2026-06
 *   node scripts/monthly-drop.mjs --chain=base --apply    # executes real txs
 *
 * Keys are read locally (never the VPS): admin token + Uniswap key from
 * PerkOS-Knowledge/.env, treasury key (0x3f0D) from Contracts/.env. --apply
 * sends real on-chain transactions; the treasury signer needs native gas.
 */
import fs from "node:fs";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, celo } from "viem/chains";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const CHAIN = args.chain === "celo" ? "celo" : "base";
const APPLY = args.apply === true || args.apply === "true";
const BASE_URL = args["base-url"] || "https://knowledge.perkos.xyz";
const MONTH =
  args.month ||
  (() => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

const ROOT = "/Users/osx/Projects/PerkOS/PerkOS-App/PerkOS-Knowledge";
const readEnv = (p, k) =>
  (fs.readFileSync(p, "utf8").match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] || "").trim().replace(/^["']|["']$/g, "");
const ADMIN = readEnv(`${ROOT}/.env`, "KNOWLEDGE_ADMIN_TOKEN");
const UNIKEY = readEnv(`${ROOT}/.env`, "UNISWAP_API_KEY");
let PK = readEnv(`${ROOT}/Contracts/.env`, "DEPLOYER_PRIVATE_KEY");
if (PK && !PK.startsWith("0x")) PK = "0x" + PK;

const CFG = {
  base: { chainId: 8453, viem: base, rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", perkos: "0xF714E60f85497D70508F7E356b5DB80e64539BA3" },
  celo: { chainId: 42220, viem: celo, rpc: "https://forno.celo.org", usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", perkos: "0xb7Ba43fBD4F2E85FCE929f7d4DFE3905Ae846A46" },
}[CHAIN];
const VAULT = "0xC609BB99C9CAc2b10cc7796b96d0a2EDf2B6f589";

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain: CFG.viem, transport: http(CFG.rpc) });
const pub = createPublicClient({ chain: CFG.viem, transport: http(CFG.rpc) });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const VAULT_ABI = parseAbi(["function setMerkleRoot(bytes32)"]);
const UH = { "content-type": "application/json", "x-api-key": UNIKEY };
const AH = { "content-type": "application/json", authorization: `Bearer ${ADMIN}` };
const fmt = (b) => (Number(b) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });

console.log(`\n=== $PERKOS monthly drop — ${MONTH} / ${CHAIN} — ${APPLY ? "APPLY (real txs)" : "DRY-RUN"} ===`);
console.log("treasury:", account.address, "| vault:", VAULT);

// 1. budget + plan (the dry-run endpoint also quotes the buyback)
let d = await (await fetch(`${BASE_URL}/api/admin/rewards/drop?month=${MONTH}&chain=${CHAIN}`, { headers: AH })).json();
if (!d.ok) { console.error("drop endpoint error:", d); process.exit(1); }
const budget = d.drop.budgetUsdc;
console.log(`budget: ${budget} USDC | wallets: ${d.drop.walletCount} | platform ${d.drop.platformUsdc} / users ${d.drop.userUsdc} USDC`);
if (d.buyback?.perkosTotal) console.log(`quote: → ${fmt(BigInt(Math.round(d.buyback.perkosTotal)) * 10n ** 18n)} $PERKOS (≈${Math.round(d.buyback.perkosTotal)})`);
if (budget <= 0) { console.log("nothing to drop (budget 0)."); process.exit(0); }
if (!APPLY) { console.log("\nDRY-RUN — re-run with --apply to execute the real swap + distribution."); process.exit(0); }

// 2. buyback: USDC → $PERKOS
const amount = String(Math.round(budget * 1e6));
const before = await pub.readContract({ address: CFG.perkos, abi: ERC20, functionName: "balanceOf", args: [account.address] });
const ap = await (await fetch("https://trade-api.gateway.uniswap.org/v1/check_approval", { method: "POST", headers: UH, body: JSON.stringify({ token: CFG.usdc, amount, walletAddress: account.address, chainId: CFG.chainId }) })).json();
if (ap.approval) { const h = await wallet.sendTransaction({ to: ap.approval.to, data: ap.approval.data, value: BigInt(ap.approval.value || 0) }); await pub.waitForTransactionReceipt({ hash: h }); console.log("approval:", h); }
const qr = await (await fetch("https://trade-api.gateway.uniswap.org/v1/quote", { method: "POST", headers: UH, body: JSON.stringify({ type: "EXACT_INPUT", amount, tokenInChainId: CFG.chainId, tokenOutChainId: CFG.chainId, tokenIn: CFG.usdc, tokenOut: CFG.perkos, swapper: account.address, routing: "CLASSIC" }) })).json();
let sig; const pd = qr.permitData;
if (pd) { const pt = Object.keys(pd.types).find((k) => k !== "EIP712Domain"); sig = await wallet.signTypedData({ domain: pd.domain, types: pd.types, primaryType: pt, message: pd.values }); }
const sr = await (await fetch("https://trade-api.gateway.uniswap.org/v1/swap", { method: "POST", headers: UH, body: JSON.stringify(sig ? { quote: qr.quote, permitData: pd, signature: sig } : { quote: qr.quote }) })).json();
if (!sr.swap?.to) { console.error("no swap tx:", JSON.stringify(sr).slice(0, 300)); process.exit(1); }
const sh = await wallet.sendTransaction({ to: sr.swap.to, data: sr.swap.data, value: BigInt(sr.swap.value || 0) });
await pub.waitForTransactionReceipt({ hash: sh });
await new Promise((r) => setTimeout(r, 3000));
const bought = (await pub.readContract({ address: CFG.perkos, abi: ERC20, functionName: "balanceOf", args: [account.address] })) - before;
console.log(`swap: ${sh} | bought ${fmt(bought)} $PERKOS`);
if (bought <= 0n) { console.error("swap landed no $PERKOS — aborting."); process.exit(1); }

// 3. distribute (accounting) → token_rewards
d = await (await fetch(`${BASE_URL}/api/admin/rewards/distribute`, { method: "POST", headers: AH, body: JSON.stringify({ month: MONTH, chain: CHAIN, perkosBought: bought.toString(), execute: true }) })).json();
if (!d.ok) { console.error("distribute error:", d); process.exit(1); }
const userPerkos = BigInt(d.distribution.userPerkos);
console.log(`distributed → users ${fmt(userPerkos)} | platform keeps ${fmt(BigInt(d.distribution.platformPerkos))} $PERKOS`);

// 4. build the Merkle root (cumUsdc + cumReward)
d = await (await fetch(`${BASE_URL}/api/admin/claims/build`, { method: "POST", headers: AH, body: JSON.stringify({}) })).json();
const dist = (d.distributions || []).find((x) => x.chain === CHAIN);
if (!dist) { console.error("no root built for", CHAIN, d); process.exit(1); }
console.log(`root: ${dist.root} | entries ${dist.entryCount}`);

// 5. fund the vault with the user $PERKOS
const fh = await wallet.writeContract({ address: CFG.perkos, abi: ERC20, functionName: "transfer", args: [VAULT, userPerkos] });
await pub.waitForTransactionReceipt({ hash: fh });
console.log("funded vault:", fh);

// 6. post the root (distributor)
const ph = await wallet.writeContract({ address: VAULT, abi: VAULT_ABI, functionName: "setMerkleRoot", args: [dist.root] });
await pub.waitForTransactionReceipt({ hash: ph });
console.log("posted root:", ph);

// 7. mark the distribution posted (dashboard drops the "root pending on-chain" hint)
const mp = await (await fetch(`${BASE_URL}/api/admin/claims/mark-posted`, { method: "POST", headers: AH, body: JSON.stringify({ chain: CHAIN, root: dist.root, txHash: ph }) })).json();
if (!mp.ok) console.warn("mark-posted warning:", mp.error);

console.log(`\n✅ drop complete — ${MONTH} / ${CHAIN}. Users can claim their $PERKOS from the dashboard.`);
