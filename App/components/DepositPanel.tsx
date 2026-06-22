'use client';

import { useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { wrapFetchWithPayment } from 'x402-fetch';

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
  const [network, setNetwork] = useState<'base' | 'celo'>('base');
  const [amount, setAmount] = useState('');
  const [creditTo, setCreditTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);

  async function deposit() {
    const amt = Number(amount);
    setMsg(''); setOk(false);
    if (!(amt > 0)) { setMsg('Enter an amount.'); return; }
    if (!walletClient) { setMsg('Connect a wallet first.'); return; }
    setBusy(true);
    try {
      const maxBase = BigInt(Math.round(amt * 1e6)); // USDC 6-dec; cap = amount
      // x402-fetch handles the 402 → EIP-3009 signature → retry with X-PAYMENT.
      const fetchWithPay = wrapFetchWithPayment(fetch, walletClient as Parameters<typeof wrapFetchWithPayment>[1], maxBase);
      const body: Record<string, unknown> = { amount: amt, network, wallet: address };
      const to = creditTo.trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(to)) body.creditTo = to;
      const res = await fetchWithPay('/api/deposit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        setOk(true);
        setMsg(`Deposited ${amt} USDC on ${network}. New balance: ${data.balance} USDC${data.transaction ? ` · tx ${String(data.transaction).slice(0, 12)}…` : ''}`);
        setAmount('');
        onDeposited?.();
      } else {
        setMsg(`Deposit failed: ${data.reason || data.error || res.status}`);
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
