'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

import ClaimPanel from './ClaimPanel';
import DepositPanel from './DepositPanel';

type Bucket = { name: string; count: number };
type Usage = {
  access: { status: string; method: string };
  knowledge: {
    knowledgeItemsAvailable: number;
    lastKnowledgeUpdate: string | null;
    byTrack: Bucket[];
    byChain: Bucket[];
  };
  metering: { message: string };
};

type AgentRow = { agentId: string | null; amount: number; count: number };
type LedgerRow = {
  kind: string;
  amount: number;
  reason: string;
  agentId: string | null;
  balanceAfter: number | null;
  createdAt: string | null;
};
type Credits = {
  ok: boolean;
  account: {
    wallet: string;
    balance: number;
    currency: string;
    totalEarned: number;
    totalSpent: number;
    totalDeposited: number;
    earningsByAgent: AgentRow[];
    spendByAgent: AgentRow[];
    recent: LedgerRow[];
  };
};

function fmt(n: number, currency = 'USDC') {
  const v = Number(n || 0);
  // up to 6 dp but trim trailing zeros
  return `${v.toFixed(6).replace(/\.?0+$/, '')} ${currency}`;
}

function Buckets({ title, rows }: { title: string; rows: Bucket[] }) {
  if (!rows.length) return <p className="body">No {title.toLowerCase()} data yet.</p>;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="bars">
      {rows.map((row) => (
        <div className="barRow" key={row.name}>
          <span>{row.name}</span>
          <div><i style={{ width: `${Math.max(8, (row.count / max) * 100)}%` }} /></div>
          <strong>{row.count}</strong>
        </div>
      ))}
    </div>
  );
}

const td: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', textAlign: 'left' };
const th: React.CSSProperties = { ...td, opacity: 0.6, fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 };
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

function short(id: string | null) {
  if (!id) return 'platform';
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export default function DashboardClient() {
  const { address, isConnected } = useAccount();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [credits, setCredits] = useState<Credits['account'] | null>(null);
  const [error, setError] = useState('');

  // Re-fetchable on its own so a deposit/claim can refresh the balance + ledger
  // without a full reload (best-effort — the dashboard renders without it).
  const loadCredits = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`/api/credits/${address}`, { cache: 'no-store' });
      const data: Credits | null = res.ok ? await res.json() : null;
      if (data?.ok) setCredits(data.account);
    } catch {
      /* ignore */
    }
  }, [address]);

  useEffect(() => {
    let active = true;
    if (!address) return;

    setError('');
    setUsage(null);
    setCredits(null);

    fetch(`/api/usage/${address}`, { cache: 'no-store' })
      .then(async (res) => { if (!res.ok) throw new Error('usage unavailable'); return res.json(); })
      .then((data) => { if (active) setUsage(data); })
      .catch(() => { if (active) setError('Unable to load live dashboard data.'); });

    loadCredits();

    return () => { active = false; };
  }, [address, loadCredits]);

  // The wallet bar lives in the nav on every state, so it's always clear which
  // wallet (if any) this dashboard is showing — its balance, deposits, and
  // claims all key off it. showBalance=false: we surface the USDC credit
  // balance below, not the wallet's native gas balance.
  const nav = (
    <nav className="dashNav">
      <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
      <div className="dashLinks" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <a href="/admin">Admin</a>
        <a href="/llms.txt">llms.txt</a>
        <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
      </div>
    </nav>
  );

  // Not connected → don't spin on "Loading…" forever; tell them to connect.
  if (!isConnected || !address) {
    return (
      <main className="dashShell">
        {nav}
        <section className="dashHero">
          <p className="eyebrow">User dashboard</p>
          <h1>Connect your wallet.</h1>
          <p className="lead">Connect the wallet your agents bill and earn from — its credit balance, earnings, deposits, and claims show up here.</p>
          <div style={{ marginTop: 20 }}><ConnectButton /></div>
        </section>
      </main>
    );
  }

  if (error) return <main className="dashShell">{nav}<p className="body">{error}</p></main>;
  if (!usage) return <main className="dashShell">{nav}<p className="body">Loading live dashboard data…</p></main>;

  const lastUpdate = usage.knowledge.lastKnowledgeUpdate
    ? new Date(usage.knowledge.lastKnowledgeUpdate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'No sync yet';
  const cur = credits?.currency ?? 'USDC';
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  return (
    <main className="dashShell">
      {nav}

      <section className="dashHero">
        <p className="eyebrow">User dashboard · <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: 0.85 }}>{shortAddr}</span></p>
        <h1>Your agents&apos; knowledge earnings.</h1>
        <p className="lead">Credit balance, what your agents earned providing research, and what they spent querying — live for <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{shortAddr}</span>.</p>
      </section>

      <section className="metricsGrid">
        <article className="metric"><span>Credit balance</span><strong>{fmt(credits?.balance ?? 0, cur)}</strong></article>
        <article className="metric"><span>Total earned</span><strong>{fmt(credits?.totalEarned ?? 0, cur)}</strong></article>
        <article className="metric"><span>Total spent</span><strong>{fmt(credits?.totalSpent ?? 0, cur)}</strong></article>
        <article className="metric"><span>Knowledge items</span><strong>{usage.knowledge.knowledgeItemsAvailable}</strong></article>
      </section>

      <DepositPanel onDeposited={loadCredits} />

      <ClaimPanel />

      <section className="dashGrid two">
        <article className="dashPanel">
          <p className="eyebrow">Supply side</p>
          <h2>Earnings by agent</h2>
          <p className="body">What each of your agents earned when its contributed knowledge was consumed.</p>
          {credits?.earningsByAgent?.length ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
              <thead><tr><th style={th}>Agent</th><th style={th}>Earned</th><th style={th}>Consumed</th></tr></thead>
              <tbody>
                {credits.earningsByAgent.map((r, i) => (
                  <tr key={i}><td style={{ ...td, ...mono }}>{short(r.agentId)}</td><td style={td}>{fmt(r.amount, cur)}</td><td style={td}>{r.count}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="body">No earnings yet. When your agents&apos; items are consumed by paid queries, earnings show here.</p>}
        </article>

        <article className="dashPanel">
          <p className="eyebrow">Demand side</p>
          <h2>Spend by agent</h2>
          <p className="body">What each of your agents spent running paid knowledge queries.</p>
          {credits?.spendByAgent?.length ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
              <thead><tr><th style={th}>Agent</th><th style={th}>Spent</th><th style={th}>Queries</th></tr></thead>
              <tbody>
                {credits.spendByAgent.map((r, i) => (
                  <tr key={i}><td style={{ ...td, ...mono }}>{short(r.agentId)}</td><td style={td}>{fmt(r.amount, cur)}</td><td style={td}>{r.count}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="body">No spend yet.</p>}
        </article>
      </section>

      <section className="dashPanel wide">
        <p className="eyebrow">Ledger</p>
        <h2>Recent credit activity</h2>
        {credits?.recent?.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead><tr><th style={th}>When</th><th style={th}>Type</th><th style={th}>Reason</th><th style={th}>Amount</th><th style={th}>Balance</th></tr></thead>
            <tbody>
              {credits.recent.map((r, i) => (
                <tr key={i}>
                  <td style={td}>{r.createdAt ? new Date(r.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                  <td style={{ ...td, color: r.kind === 'credit' ? '#5fd0a0' : '#e0a05f' }}>{r.kind === 'credit' ? '+ credit' : '− debit'}</td>
                  <td style={td}>{r.reason}</td>
                  <td style={td}>{fmt(r.amount, cur)}</td>
                  <td style={td}>{r.balanceAfter == null ? '—' : fmt(r.balanceAfter, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="body">No credit activity yet. Billing is currently {credits ? 'in metered_free mode (free)' : 'unavailable'} — earnings and charges populate this ledger once credit pricing is enabled.</p>
        )}
      </section>

      <section className="dashGrid two">
        <article className="dashPanel">
          <p className="eyebrow">Live database</p>
          <h2>Research coverage</h2>
          <Buckets title="Tracks" rows={usage.knowledge.byTrack} />
        </article>
        <article className="dashPanel">
          <p className="eyebrow">Chains</p>
          <h2>Indexed chain coverage</h2>
          <Buckets title="Chains" rows={usage.knowledge.byChain} />
        </article>
      </section>

      <p className="body" style={{ opacity: 0.5, fontSize: 12, marginTop: 16 }}>Last knowledge sync: {lastUpdate}</p>
    </main>
  );
}
