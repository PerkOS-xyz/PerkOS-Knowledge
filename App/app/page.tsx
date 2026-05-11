const features = [
  ['Agent-ready search', 'Expose curated research through fast APIs designed for autonomous agents, assistants, and PerkOS services.'],
  ['Private by default', 'Separate internal knowledge, sanitized public briefs, and paid external access without leaking operational notes.'],
  ['x402 access layer', 'Let outside agents pay for premium briefs, topic reports, and custom research through programmable payment rails.'],
  ['Built for reuse', 'Research is curated once; internal and external agents can reuse the same source of truth.']
];

const apiCards = [
  ['Search', '/knowledge/search', 'Query vectorized research across protocols, markets, agents, and PerkOS product notes.'],
  ['Briefs', '/knowledge/brief/:agent', 'Generate role-specific briefs for builders, researchers, strategists, and operators.'],
  ['Paid reports', '/paid/report/:slug', 'Serve sanitized premium research to external agents with x402 payment verification.']
];

const rails = ['Base', 'Celo', 'Solana', 'x402', 'Firebase', 'Qdrant', 'Postgres', 'Docker'];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <nav className="nav">
          <div className="brand"><span className="orb" /> PerkOS Knowledge</div>
          <a href="/healthz" className="status">Live health</a>
        </nav>

        <div className="heroGrid">
          <div>
            <p className="eyebrow">Live knowledge infrastructure for AI agents</p>
            <h1>Research once. Let every agent know what matters.</h1>
            <p className="lead">
              PerkOS Knowledge turns curated research into a reusable, searchable, paid knowledge layer for internal agents and external autonomous clients.
            </p>
            <div className="actions">
              <a className="primary" href="/api/health">Check API</a>
              <a className="secondary" href="https://github.com/PerkOS-xyz/knowledge">Read the code</a>
            </div>
          </div>

          <div className="console" aria-label="API preview">
            <div className="consoleTop"><span /> <span /> <span /></div>
            <pre>{`GET /knowledge/search
Authorization: x402 or internal token

{
  "query": "ERC-8004 x402 agent payments",
  "scope": "sanitized-public",
  "results": "source-cited briefs"
}`}</pre>
          </div>
        </div>
      </section>

      <section className="strip">
        {rails.map((rail) => <span key={rail}>{rail}</span>)}
      </section>

      <section className="section">
        <p className="eyebrow">Why it exists</p>
        <h2>Knowledge that agents can actually call.</h2>
        <div className="features">
          {features.map(([title, text]) => (
            <article className="card" key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section split">
        <div>
          <p className="eyebrow">Interfaces</p>
          <h2>Internal memory, public products, paid access.</h2>
          <p className="body">
            The service is designed to run as a Dockerized application behind a reverse proxy, with private data services isolated from the public internet.
          </p>
        </div>
        <div className="apiList">
          {apiCards.map(([title, path, text]) => (
            <article key={path}>
              <code>{path}</code>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="cta">
        <p className="eyebrow">PerkOS agent network</p>
        <h2>A knowledge service that can become a skill, an API, and a market.</h2>
        <p>Next: indexing pipeline, authenticated internal search, and x402-paid public endpoints.</p>
      </section>
    </main>
  );
}
