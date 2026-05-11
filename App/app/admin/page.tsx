import WalletGate from '../../components/WalletGate';

type Bucket = { name: string; count: number };
type Item = { title: string; source: string; date: string; track: string; path: string; agents: string[]; chains: string[]; summary: string; updated_at: string };

async function getStats() {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://knowledge.perkos.xyz';
  const res = await fetch(`${base}/api/stats`, { cache: 'no-store' });
  if (!res.ok) throw new Error('stats unavailable');
  return res.json();
}

function Buckets({ title, rows }: { title: string; rows: Bucket[] }) {
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <article className="dashPanel">
      <p className="eyebrow">{title}</p>
      <div className="bars">
        {rows.map((row) => (
          <div className="barRow" key={row.name}>
            <span>{row.name}</span>
            <div><i style={{ width: `${Math.max(8, (row.count / max) * 100)}%` }} /></div>
            <strong>{row.count}</strong>
          </div>
        ))}
      </div>
    </article>
  );
}

export default async function AdminDashboard() {
  const stats = await getStats();

  return (
    <WalletGate>
      <main className="dashShell">
        <nav className="dashNav">
          <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
          <div className="dashLinks"><a href="/dashboard">User</a><a href="/knowledge/vector-search?q=agent%20payments%20x402">Vector API</a></div>
        </nav>

        <section className="dashHero">
          <p className="eyebrow">Admin dashboard</p>
          <h1>Accumulated knowledge database.</h1>
          <p className="lead">Live view of curated research synchronized into Postgres and Qdrant.</p>
        </section>

        <section className="metricsGrid">
          <article className="metric"><span>Total items</span><strong>{stats.totalItems}</strong></article>
          <article className="metric"><span>Tracks</span><strong>{stats.byTrack.length}</strong></article>
          <article className="metric"><span>Agents</span><strong>{stats.byAgent.length}</strong></article>
          <article className="metric"><span>Last sync</span><strong>{new Date(stats.lastUpdate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</strong></article>
        </section>

        <section className="dashGrid three">
          <Buckets title="Tracks" rows={stats.byTrack} />
          <Buckets title="Agents" rows={stats.byAgent} />
          <Buckets title="Chains" rows={stats.byChain} />
        </section>

        <section className="dashPanel wide">
          <div className="panelHead">
            <div><p className="eyebrow">Latest ingested</p><h2>Research items</h2></div>
            <div className="dashLinks"><a href="/knowledge/search?q=x402&limit=5">Keyword search</a><a href="/knowledge/vector-search?q=agent%20payments%20x402&limit=5">Vector search</a></div>
          </div>
          <div className="itemList">
            {stats.latest.map((item: Item) => (
              <article key={item.path}>
                <div className="itemMeta"><span>{item.track}</span><span>{item.date || 'unknown'}</span><span>{item.source}</span></div>
                <h3>{item.title}</h3>
                <p>{item.summary}</p>
                <div className="chips">{[...item.agents, ...item.chains].map((chip) => <code key={`${item.path}-${chip}`}>{chip}</code>)}</div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </WalletGate>
  );
}
