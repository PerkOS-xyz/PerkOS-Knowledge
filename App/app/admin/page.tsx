import WalletGate from '../../components/WalletGate';

type Bucket = { name: string; count: number; last_update?: string };

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
      {rows.length ? (
        <div className="bars">
          {rows.map((row) => (
            <div className="barRow" key={row.name}>
              <span>{row.name}</span>
              <div><i style={{ width: `${Math.max(8, (row.count / max) * 100)}%` }} /></div>
              <strong>{row.count}</strong>
            </div>
          ))}
        </div>
      ) : <p className="body">No {title.toLowerCase()} data yet.</p>}
    </article>
  );
}

export default async function AdminDashboard() {
  const stats = await getStats();
  const lastSync = stats.lastUpdate
    ? new Date(stats.lastUpdate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'No sync yet';

  return (
    <WalletGate>
      <main className="dashShell">
        <nav className="dashNav">
          <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
          <div className="dashLinks"><a href="/dashboard">User</a><a href="/api/stats">Stats API</a></div>
        </nav>

        <section className="dashHero">
          <p className="eyebrow">Admin dashboard</p>
          <h1>Operational knowledge database.</h1>
          <p className="lead">Only live database counts are shown here. No simulated agent activity, fake usage, or generated content previews.</p>
        </section>

        <section className="metricsGrid">
          <article className="metric"><span>Total records</span><strong>{stats.totalItems}</strong></article>
          <article className="metric"><span>Sources</span><strong>{stats.bySource.length}</strong></article>
          <article className="metric"><span>Tracks</span><strong>{stats.byTrack.length}</strong></article>
          <article className="metric"><span>Last sync</span><strong>{lastSync}</strong></article>
        </section>

        <section className="dashGrid three">
          <Buckets title="Sources" rows={stats.bySource} />
          <Buckets title="Tracks" rows={stats.byTrack} />
          <Buckets title="Chains" rows={stats.byChain} />
        </section>

        <section className="dashPanel wide">
          <p className="eyebrow">Data policy</p>
          <h2>Real records only.</h2>
          <p className="body">This view intentionally hides agent-attribution charts and latest narrative previews because the current schema stores tags and summaries, not verified agent contributions or audited user activity.</p>
        </section>
      </main>
    </WalletGate>
  );
}
