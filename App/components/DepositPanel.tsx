'use client';

import { useState } from 'react';
import { getAddress, type WalletClient } from 'viem';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { wrapFetchWithPayment } from 'x402-fetch';

const CHAIN_ID: Record<'base' | 'celo', number> = { base: 8453, celo: 42220 };

// x402 "exact" EIP-3009 authorization typed-data (USDC transferWithAuthorization).
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

type PaymentRequirements = {
  scheme: string; network: string; maxAmountRequired: string; payTo: string;
  asset: string; maxTimeoutSeconds: number; extra?: { name?: string; version?: string };
};

function randomNonce(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build a signed x402 `X-PAYMENT` header manually — x402-fetch 1.2.0's network
 * enum lacks "celo", so it can't be used for Celo. We sign the EIP-3009
 * authorization against the token's real EIP-712 domain (name/version come from
 * the 402's paymentRequirements.extra, which the server sets per token) and
 * base64 the x402 payload. Works for any EIP-3009 USDC; used here for Celo.
 */
async function signX402Payment(
  walletClient: WalletClient,
  req: PaymentRequirements,
  payer: `0x${string}`,
  chainId: number,
): Promise<string> {
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + (req.maxTimeoutSeconds || 120));
  const nonce = randomNonce();
  const value = BigInt(req.maxAmountRequired);
  const authorization = {
    from: getAddress(payer),
    to: getAddress(req.payTo),
    value,
    validAfter,
    validBefore,
    nonce,
  };
  // Replicate x402's signAuthorization EXACTLY: call signTypedData(data) with NO
  // `account` field, letting the wallet sign with its connected account. Passing
  // an explicit `account` made a smart wallet (EIP-7702) try to EXECUTE the
  // transferWithAuthorization as a transaction (from its EOA signer, no gas)
  // instead of signing the EIP-3009 auth gaslessly. (Base worked via x402-fetch,
  // which signs this way; Celo uses this manual path, so it must match.)
  const signature = await (walletClient.signTypedData as (a: unknown) => Promise<`0x${string}`>)({
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    domain: {
      name: req.extra?.name || 'USDC',
      version: req.extra?.version || '2',
      chainId,
      verifyingContract: getAddress(req.asset),
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  const paymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: req.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  return btoa(JSON.stringify(paymentPayload));
}

const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.04)', color: 'inherit', fontSize: 13 };
const btn: React.CSSProperties = { padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(124,247,200,0.4)', background: 'rgba(124,247,200,0.16)', color: 'inherit', cursor: 'pointer', fontSize: 14, fontWeight: 700 };
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: 0.85 };

const NETS = [
  { key: 'base', label: 'Base' },
  { key: 'celo', label: 'Celo' },
] as const;

/** Top up a prepaid balance with on-chain USDC (Base/Celo) via x402 → PerkOS Stack. */
export default function DepositPanel({ onDeposited }: { onDeposited?: () => void }) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const [network, setNetwork] = useState<'base' | 'celo'>('base');
  const [amount, setAmount] = useState('');
  const [creditTo, setCreditTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  function onSuccess(amt: number, data: { balance?: number; transaction?: string }) {
    setOk(true);
    setMsg(`Deposited ${amt} USDC on ${network}. New balance: ${data.balance} USDC${data.transaction ? ` · tx ${String(data.transaction).slice(0, 12)}…` : ''}`);
    setAmount('');
    onDeposited?.();
  }

  async function deposit() {
    const amt = Number(amount);
    setMsg(''); setOk(false);
    if (!(amt > 0)) { setMsg('Enter an amount.'); return; }
    if (!walletClient || !address) { setMsg('Connect a wallet first.'); return; }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { amount: amt, network, wallet: address };
      const to = creditTo.trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(to)) body.creditTo = to;

      if (network === 'base') {
        // Base: x402-fetch handles 402 → EIP-3009 signature → retry. (Proven path.)
        const maxBase = BigInt(Math.round(amt * 1e6));
        const fetchWithPay = wrapFetchWithPayment(fetch, walletClient as Parameters<typeof wrapFetchWithPayment>[1], maxBase);
        const res = await fetchWithPay('/api/deposit', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) onSuccess(amt, data);
        else setMsg(`Deposit failed: ${data.reason || data.error || res.status}`);
      } else {
        // Celo: x402-fetch's network enum has no "celo", so do the x402 dance by
        // hand — get the 402 challenge, sign the EIP-3009 auth, retry with X-PAYMENT.
        await switchChainAsync({ chainId: CHAIN_ID.celo }).catch(() => {});
        const r1 = await fetch('/api/deposit', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        if (r1.status !== 402) {
          const d = await r1.json().catch(() => ({}));
          setMsg(`Deposit failed: ${d.reason || d.error || r1.status}`);
          return;
        }
        const challenge = await r1.json();
        const accepts: PaymentRequirements[] = challenge.accepts || [];
        const req = accepts.find((a) => a.network === 'celo');
        if (!req) { setMsg('Celo not offered by the server.'); return; }
        const xPayment = await signX402Payment(walletClient, req, address, CHAIN_ID.celo);
        const r2 = await fetch('/api/deposit', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment },
          body: JSON.stringify(body),
        });
        const data = await r2.json().catch(() => ({}));
        if (data.ok) onSuccess(amt, data);
        else setMsg(`Deposit failed: ${data.reason || data.error || r2.status}`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message.slice(0, 140) : 'Deposit failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dashPanel wide" style={{ border: '1px solid rgba(124,247,200,0.25)' }}>
      <p className="eyebrow">Deposit · top up with USDC</p>
      <h2>Add credit</h2>
      <p className="body" style={{ fontSize: 13 }}>
        Pay USDC on-chain (Base or Celo) via x402 → settled by PerkOS Stack → credited to your balance.
        Your agents spend from it. Optionally fund another wallet (e.g. one of your agents).
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
        <label style={lbl}>Network
          <select style={inp} value={network} onChange={(e) => setNetwork(e.target.value as 'base' | 'celo')}>
            {NETS.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}
          </select>
        </label>
        <label style={lbl}>Amount (USDC)
          <input style={{ ...inp, width: 120 }} type="number" step="0.01" min="0" placeholder="10.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label style={{ ...lbl, flex: 1, minWidth: 220 }}>Fund another wallet (optional)
          <input style={inp} placeholder="0x… (default: your wallet)" value={creditTo} onChange={(e) => setCreditTo(e.target.value)} />
        </label>
        <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} onClick={deposit} disabled={busy}>
          {busy ? 'Confirm in wallet…' : 'Deposit'}
        </button>
      </div>
      {msg ? <p className="body" style={{ fontSize: 12, marginTop: 10, color: ok ? '#5fd0a0' : '#e0a05f' }}>{msg}</p> : null}
    </section>
  );
}
