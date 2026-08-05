import SiteNav from '../components/SiteNav';

const features = [
  ['Ask in plain words', 'People and agents search the same commons and get answers back with the sources they came from.'],
  ['Yours stays yours', 'Working notes stay private. You decide what becomes part of the shared commons, and nothing leaks by accident.'],
  ['Contributors are recognized', 'Every time shared knowledge answers a question, the person who contributed it is credited and rewarded for it.'],
  ['Checked before it spreads', 'Items are validated independently before they join the shared commons, so what circulates is worth trusting.']
];

const apiCards = [
  ['Search', '/knowledge/search', 'Ask across everything the commons holds and get answers with their sources.'],
  ['Briefs', '/knowledge/brief/:agent', 'A short brief written for whoever asked, whether that is a builder, a researcher, or an operator.'],
  ['Reports', '/paid/report/:slug', 'Deeper reports for agents outside your team, so the people who wrote them get something back.']
];

const rails = ['Open source', 'Self-hostable', 'MCP', 'Qdrant', 'Postgres', 'Firebase', 'Docker'];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <SiteNav />

        <div className="heroGrid">
          <div>
            <p className="eyebrow">A shared knowledge commons</p>
            <h1>Write it down once. Every helper can use it.</h1>
            <p className="lead">
              PerkOS Knowledge is a commons. People and teams contribute what they know, agents look it up when
              they need an answer, and the people who contributed are recognized every time their knowledge helps.
            </p>
            <div className="actions">
              <a className="primary" href="/dashboard">Open dashboard</a>
              <a className="secondary" href="/healthz">Live health</a>
            </div>
          </div>

          <div className="console" aria-label="API preview">
            <div className="consoleTop"><span /> <span /> <span /></div>
            <pre>{`GET /knowledge/search
Authorization: Bearer <your key>

{
  "query": "how our refund policy works",
  "scope": "shared",
  "results": "answers, with their sources"
}`}</pre>
          </div>
        </div>
      </section>

      <section className="strip">
        {rails.map((rail) => <span key={rail}>{rail}</span>)}
      </section>

      <section className="section">
        <p className="eyebrow">Why it exists</p>
        <h2>What a team knows should outlive the person who knew it.</h2>
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
          <h2>Private notes, shared answers, and a way to give back.</h2>
          <p className="body">
            It runs as a small Docker service behind your own proxy, with the data kept off the public internet.
            The code is open, so you can run the whole thing yourself.
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
        <h2>Knowledge that stays useful, and stays with the people who created it.</h2>
        <p>Any agent that speaks MCP can read the commons, not just ours.</p>
      </section>
    </main>
  );
}
