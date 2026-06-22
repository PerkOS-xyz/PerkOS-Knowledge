'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

type Policy = { tier: string; price: { amount: string; currency: string } };
type Cfg = { mode: string; policies: Policy[]; env: Record<string, string> };
type BillingRow = { agent_id: string; wallet: string | null; exempt: boolean; role: string; note: string | null; updated_at: string | null };
type Settlement = { id: string; provider_wallet: string; amount: number; currency: string; status: string; tx_hash: string | null; created_at: string | null };
type Tk = {
  mode: string;
  prices: { public: number; private: number; premium: number; enterprise: number };
  feeProviderBps: number; feePlatformBps: number; feeRewardBps: number;
  rewardResearcherBps: number; buybackEnabled: boolean; buybackThreshold: number;
  updatedBy?: string | null;
};
type TkSummary = {
  platformRevenue: { total: number; byTier: { tier: string; amount: number; count: number }[] };
  rewardPool: { pending: number; pendingCount: number; distributed: number };
  currency: string;
};
const TK_TIERS = ['public', 'private', 'premium', 'enterprise'] as const;

const td: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', textAlign: 'left', fontSize: 13 };
const th: React.CSSProperties = { ...td, opacity: 0.6, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.04)', color: 'inherit', fontSize: 13 };
const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(95,208,160,0.15)', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, opacity: 0.85 };
function shortW(w: string | null) { return w ? `${w.slice(0, 8)}…${w.slice(-6)}` : '—'; }

export default function AdminClient() {
  const { address } = useAccount();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [billing, setBilling] = useState<BillingRow[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [onChain, setOnChain] = useState(false);
  const [tk, setTk] = useState<Tk | null>(null);
  const [tkSum, setTkSum] = useState<TkSummary | null>(null);
  const [tkForm, setTkForm] = useState<Tk | null>(null);
  const [msg, setMsg] = useState('');

  const adminFetch = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(path, { ...init, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-admin-wallet': address || '', ...(init?.headers || {}) } }),
    [address],
  );

  const refresh = useCallback(async () => {
    if (!address) return;
    const [c, b, s, t] = await Promise.all([
      adminFetch('/api/admin/x402/config').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      adminFetch('/api/admin/billing').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      adminFetch('/api/admin/settle').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      adminFetch('/api/admin/tokenomics').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (c?.ok) setCfg(c);
    if (b?.ok) setBilling(b.rows || []);
    if (s?.ok) { setSettlements(s.settlements || []); setOnChain(Boolean(s.onChain)); }
    if (t?.ok) { setTk(t.config); setTkForm(t.config); setTkSum(t.summary); }
    if (!c?.ok && !b?.ok && !t?.ok) setMsg('Admin access denied — connect an allowlisted wallet.');
  }, [address, adminFetch]);

  useEffect(() => { refresh(); }, [refresh]);

  // form state
  const [bAgent, setBAgent] = useState(''); const [bExempt, setBExempt] = useState(true); const [bRole, setBRole] = useState('provider');
  const [gWallet, setGWallet] = useState(''); const [gAmount, setGAmount] = useState('');
  const [sWallet, setSWallet] = useState(''); const [sAmount, setSAmount] = useState('');

  async function setBillingRow() {
    setMsg('');
    const r = await adminFetch('/api/admin/billing', { method: 'POST', body: JSON.stringify({ agentId: bAgent.trim(), exempt: bExempt, role: bRole }) });
    setMsg(r.ok ? `Whitelist updated: ${bAgent} (exempt=${bExempt}, ${bRole})` : 'Failed to update billing.');
    setBAgent(''); await refresh();
  }
  async function grant() {
    setMsg('');
    const r = await adminFetch('/api/admin/credits/grant', { method: 'POST', body: JSON.stringify({ wallet: gWallet.trim(), amount: Number(gAmount) }) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? `Granted ${gAmount} → ${shortW(gWallet.trim())}. New balance: ${d.balance}` : `Grant failed: ${d.error || r.status}`);
    setGWallet(''); setGAmount('');
  }
  async function settle() {
    setMsg('');
    const body: Record<string, unknown> = { wallet: sWallet.trim() };
    if (sAmount.trim()) body.amount = Number(sAmount);
    const r = await adminFetch('/api/admin/settle', { method: 'POST', body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? `Settle ${shortW(sWallet.trim())}: ${d.status}${d.txHash ? ' tx=' + d.txHash : ''} (amount ${d.amount})` : `Settle failed: ${d.error || d.status || r.status}`);
    setSWallet(''); setSAmount(''); await refresh();
  }

  const setTkField = (patch: Partial<Tk>) => setTkForm((f) => (f ? { ...f, ...patch } : f));
  const setTkPrice = (tier: (typeof TK_TIERS)[number], v: number) =>
    setTkForm((f) => (f ? { ...f, prices: { ...f.prices, [tier]: v } } : f));
  const feeSumBps = tkForm ? tkForm.feeProviderBps + tkForm.feePlatformBps + tkForm.feeRewardBps : 0;

  async function saveTk() {
    if (!tkForm) return;
    setMsg('');
    const r = await adminFetch('/api/admin/tokenomics', { method: 'POST', body: JSON.stringify(tkForm) });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? 'Tokenomics saved.' : `Save failed: ${d.error || r.status}`);
    await refresh();
  }

  const cur = tkSum?.currency ?? cfg?.policies?.[0]?.price.currency ?? 'USDC';

  return (
    <main className="dashShell">
      <nav className="dashNav">
        <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
        <div className="dashLinks"><a href="/admin">Stats</a><a href="/dashboard">User</a></div>
      </nav>

      <section className="dashHero">
        <p className="eyebrow">Admin · billing</p>
        <h1>Pricing, whitelist, credits &amp; payouts.</h1>
        <p className="lead">Manage the two-sided market: who pays, who&apos;s exempt, and pay providers out.</p>
      </section>

      {msg ? <section className="dashPanel wide"><p className="body">{msg}</p></section> : null}

      {/* Revenue + reward pool (the platform's cut) */}
      <section className="metricsGrid">
        <article className="metric"><span>Platform revenue</span><strong>{tkSum ? tkSum.platformRevenue.total.toFixed(4) : '…'} {cur}</strong></article>
        <article className="metric"><span>Reward pool · pending</span><strong>{tkSum ? tkSum.rewardPool.pending.toFixed(4) : '…'} {cur}</strong></article>
        <article className="metric"><span>Mode</span><strong>{tk?.mode ?? '…'}</strong></article>
        <article className="metric"><span>$PERKOS buyback</span><strong>{tk ? (tk.buybackEnabled ? 'on' : 'off') : '…'}</strong></article>
      </section>

      {/* Tokenomics — editable */}
      <section className="dashPanel wide">
        <p className="eyebrow">Tokenomics · editable</p>
        <h2>Pricing &amp; fee split</h2>
        {tkForm ? (
          <div style={{ display: 'grid', gap: 14, marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={lbl}>Mode
                <select style={inp} value={tkForm.mode} onChange={(e) => setTkField({ mode: e.target.value })}>
                  <option value="metered_free">metered_free</option>
                  <option value="credit">credit</option>
                  <option value="enforce">enforce</option>
                </select>
              </label>
              {TK_TIERS.map((t) => (
                <label key={t} style={lbl}>{t} ({cur})
                  <input style={{ ...inp, width: 96 }} type="number" step="0.001" min="0" value={tkForm.prices[t]} onChange={(e) => setTkPrice(t, Number(e.target.value))} />
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={lbl}>Provider %
                <input style={{ ...inp, width: 80 }} type="number" min="0" max="100" value={tkForm.feeProviderBps / 100} onChange={(e) => setTkField({ feeProviderBps: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <label style={lbl}>Platform %
                <input style={{ ...inp, width: 80 }} type="number" min="0" max="100" value={tkForm.feePlatformBps / 100} onChange={(e) => setTkField({ feePlatformBps: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <label style={lbl}>Reward %
                <input style={{ ...inp, width: 80 }} type="number" min="0" max="100" value={tkForm.feeRewardBps / 100} onChange={(e) => setTkField({ feeRewardBps: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <span style={{ fontSize: 12, alignSelf: 'center', color: feeSumBps === 10000 ? 'inherit' : '#ff8080' }}>
                Σ {(feeSumBps / 100).toFixed(0)}% {feeSumBps === 10000 ? '✓' : '(must = 100)'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={lbl}>Researcher % of reward
                <input style={{ ...inp, width: 96 }} type="number" min="0" max="100" value={tkForm.rewardResearcherBps / 100} onChange={(e) => setTkField({ rewardResearcherBps: Math.round(Number(e.target.value) * 100) })} />
              </label>
              <span style={{ fontSize: 12, alignSelf: 'center', opacity: 0.7 }}>requester {(100 - tkForm.rewardResearcherBps / 100).toFixed(0)}%</span>
              <label style={{ ...lbl, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={tkForm.buybackEnabled} onChange={(e) => setTkField({ buybackEnabled: e.target.checked })} /> Buyback enabled
              </label>
              <label style={lbl}>Buyback threshold ({cur})
                <input style={{ ...inp, width: 96 }} type="number" min="0" value={tkForm.buybackThreshold} onChange={(e) => setTkField({ buybackThreshold: Number(e.target.value) })} />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button style={btn} onClick={saveTk} disabled={feeSumBps !== 10000}>Save tokenomics</button>
              {tk?.updatedBy ? <span style={{ fontSize: 12, opacity: 0.6 }}>last edit: {shortW(tk.updatedBy)}</span> : null}
            </div>
            <p className="body" style={{ fontSize: 12, opacity: 0.7 }}>
              Each paid query splits: <strong>provider payout</strong> / <strong>platform take</strong> (PerkOS revenue) / <strong>$PERKOS reward pool</strong>. The reward accrues until a buyback epoch (threshold) fires; buyback stays OFF until a treasury key + legal sign-off. Token/pay-to are infra env (<code>KNOWLEDGE_X402_TOKEN</code>={cfg?.env?.KNOWLEDGE_X402_TOKEN ?? '…'}, pay-to={cfg?.env?.KNOWLEDGE_X402_PAY_TO ?? '…'}).
            </p>
          </div>
        ) : <p className="body">Loading tokenomics…</p>}
      </section>

      {/* Whitelist */}
      <section className="dashPanel wide">
        <p className="eyebrow">Whitelist · agent_billing</p>
        <h2>Exempt agents (free queries)</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0 12px' }}>
          <input style={{ ...inp, minWidth: 240 }} placeholder="agentId" value={bAgent} onChange={(e) => setBAgent(e.target.value)} />
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={bExempt} onChange={(e) => setBExempt(e.target.checked)} /> exempt</label>
          <select style={inp} value={bRole} onChange={(e) => setBRole(e.target.value)}><option value="consumer">consumer</option><option value="provider">provider</option><option value="both">both</option></select>
          <button style={btn} onClick={setBillingRow} disabled={!bAgent.trim()}>Save</button>
        </div>
        {billing.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Agent</th><th style={th}>Wallet</th><th style={th}>Exempt</th><th style={th}>Role</th></tr></thead>
            <tbody>{billing.map((r) => (<tr key={r.agent_id}><td style={{ ...td, ...mono }}>{r.agent_id}</td><td style={{ ...td, ...mono }}>{shortW(r.wallet)}</td><td style={td}>{r.exempt ? '✓ free' : '—'}</td><td style={td}>{r.role}</td></tr>))}</tbody>
          </table>
        ) : <p className="body">No billing overrides yet.</p>}
      </section>

      {/* Grants */}
      <section className="dashGrid two">
        <article className="dashPanel">
          <p className="eyebrow">Credits</p>
          <h2>Grant / top-up</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <input style={{ ...inp, flex: 1, minWidth: 200 }} placeholder="wallet 0x…" value={gWallet} onChange={(e) => setGWallet(e.target.value)} />
            <input style={{ ...inp, width: 110 }} placeholder="amount" value={gAmount} onChange={(e) => setGAmount(e.target.value)} />
            <button style={btn} onClick={grant} disabled={!gWallet.trim() || !gAmount.trim()}>Grant</button>
          </div>
        </article>

        <article className="dashPanel">
          <p className="eyebrow">Payouts</p>
          <h2>Settle a provider {onChain ? '· on-chain ✓' : '· record-only'}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <input style={{ ...inp, flex: 1, minWidth: 200 }} placeholder="provider wallet 0x…" value={sWallet} onChange={(e) => setSWallet(e.target.value)} />
            <input style={{ ...inp, width: 110 }} placeholder="amount (opt)" value={sAmount} onChange={(e) => setSAmount(e.target.value)} />
            <button style={btn} onClick={settle} disabled={!sWallet.trim()}>Settle</button>
          </div>
          {!onChain ? <p className="body" style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>No treasury key set — settlements are recorded for manual payout (balance kept).</p> : null}
        </article>
      </section>

      {/* Settlements */}
      <section className="dashPanel wide">
        <p className="eyebrow">Ledger · settlements</p>
        <h2>Recent payouts</h2>
        {settlements.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>When</th><th style={th}>Provider</th><th style={th}>Amount</th><th style={th}>Status</th><th style={th}>Tx</th></tr></thead>
            <tbody>{settlements.map((s) => (
              <tr key={s.id}>
                <td style={td}>{s.created_at ? new Date(s.created_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                <td style={{ ...td, ...mono }}>{shortW(s.provider_wallet)}</td>
                <td style={td}>{s.amount} {s.currency}</td>
                <td style={td}>{s.status}</td>
                <td style={{ ...td, ...mono }}>{s.tx_hash ? `${s.tx_hash.slice(0, 10)}…` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="body">No settlements yet.</p>}
      </section>
    </main>
  );
}
