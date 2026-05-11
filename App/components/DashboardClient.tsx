'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';

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

export default function DashboardClient() {
  const { address } = useAccount();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!address) return;

    setError('');
    setUsage(null);
    fetch(`/api/usage/${address}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('usage unavailable');
        return res.json();
      })
      .then((data) => {
        if (active) setUsage(data);
      })
      .catch(() => {
        if (active) setError('Unable to load live dashboard data.');
      });

    return () => { active = false; };
  }, [address]);

  if (error) return <p className="body">{error}</p>;
  if (!usage) return <p className="body">Loading live dashboard data…</p>;

  const lastUpdate = usage.knowledge.lastKnowledgeUpdate
    ? new Date(usage.knowledge.lastKnowledgeUpdate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'No sync yet';

  return (
    <main className="dashShell">
      <nav className="dashNav">
        <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
        <div className="dashLinks"><a href="/admin">Admin</a><a href="/llms.txt">llms.txt</a></div>
      </nav>

      <section className="dashHero">
        <p className="eyebrow">User dashboard</p>
        <h1>Wallet access and live knowledge.</h1>
        <p className="lead">Your connected wallet has real allowlist access to the Knowledge dashboard.</p>
      </section>

      <section className="metricsGrid">
        <article className="metric"><span>Access</span><strong>{usage.access.status}</strong></article>
        <article className="metric"><span>Access method</span><strong>{usage.access.method.replace('_', ' ')}</strong></article>
        <article className="metric"><span>Knowledge items</span><strong>{usage.knowledge.knowledgeItemsAvailable}</strong></article>
        <article className="metric"><span>Last sync</span><strong>{lastUpdate}</strong></article>
      </section>

      <section className="dashGrid two">
        <article className="dashPanel">
          <p className="eyebrow">Live database</p>
          <h2>Research coverage</h2>
          <p className="body">These counts come from the live Postgres <code>research_items</code> table.</p>
          <Buckets title="Tracks" rows={usage.knowledge.byTrack} />
        </article>

        <article className="dashPanel">
          <p className="eyebrow">Chains</p>
          <h2>Indexed chain coverage</h2>
          <Buckets title="Chains" rows={usage.knowledge.byChain} />
        </article>
      </section>

      <section className="dashPanel wide">
        <p className="eyebrow">Metering</p>
        <h2>No live usage meter connected yet.</h2>
        <p className="body">{usage.metering.message} Until request/payment events are stored, this dashboard does not show simulated request counts, revenue, or settlements.</p>
      </section>
    </main>
  );
}
