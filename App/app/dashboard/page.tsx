import WalletGate from '../../components/WalletGate';
import { ALLOWED_WALLET } from '../../lib/auth';

async function getUsage() {
  const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://knowledge.perkos.xyz';
  const res = await fetch(`${base}/api/usage/${ALLOWED_WALLET}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('usage unavailable');
  return res.json();
}

export default async function UserDashboard() {
  const usage = await getUsage();

  return (
    <WalletGate>
      <main className="dashShell">
        <nav className="dashNav">
          <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
          <div className="dashLinks"><a href="/admin">Admin</a><a href="/llms.txt">llms.txt</a></div>
        </nav>

        <section className="dashHero">
          <p className="eyebrow">User dashboard</p>
          <h1>Agent console and x402 usage.</h1>
          <p className="lead">Wallet <code>{usage.wallet}</code> can see its agent access, available briefs, and payment metering status.</p>
        </section>

        <section className="metricsGrid">
          <article className="metric"><span>Plan</span><strong>{usage.plan}</strong></article>
          <article className="metric"><span>Knowledge items</span><strong>{usage.usage.knowledgeItemsAvailable}</strong></article>
          <article className="metric"><span>x402 paid</span><strong>${usage.x402.totalPaidUsd}</strong></article>
          <article className="metric"><span>Requests</span><strong>{usage.x402.totalRequests}</strong></article>
        </section>

        <section className="dashGrid two">
          <article className="dashPanel">
            <p className="eyebrow">Agent console</p>
            <h2>Available agents</h2>
            <div className="tableList">
              {usage.agents.map((agent: { name: string; role: string; status: string; calls: number }) => (
                <div className="tableRow" key={agent.name}>
                  <div><strong>{agent.name}</strong><span>{agent.role}</span></div>
                  <code>{agent.status}</code>
                  <span>{agent.calls} items</span>
                </div>
              ))}
            </div>
          </article>

          <article className="dashPanel">
            <p className="eyebrow">Payments</p>
            <h2>x402 meter</h2>
            <p className="body">{usage.x402.note}</p>
            <div className="paymentBox">
              <div><span>Status</span><strong>{usage.x402.status}</strong></div>
              <div><span>Pending settlement</span><strong>${usage.x402.pendingSettlementUsd}</strong></div>
            </div>
          </article>
        </section>
      </main>
    </WalletGate>
  );
}
