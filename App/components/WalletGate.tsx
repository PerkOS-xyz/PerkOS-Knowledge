'use client';

import { useEffect, useState } from 'react';

const allowedWallet = '<WALLET_ALLOWLIST_ENV>';

export default function WalletGate({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    setSaved(window.localStorage.getItem('perkosKnowledgeWallet') || '');
  }, []);

  const active = (saved || wallet).trim();
  const allowed = active.toLowerCase() === allowedWallet.toLowerCase();

  if (allowed) return <>{children}</>;

  return (
    <main className="dashShell">
      <section className="dashHero compact">
        <p className="eyebrow">Wallet gated preview</p>
        <h1>Connect the allowed Knowledge wallet.</h1>
        <p className="lead">This private preview is currently allowlisted for one wallet while x402 auth and payments are wired in.</p>
        <div className="walletBox">
          <input
            value={wallet}
            onChange={(event) => setWallet(event.target.value)}
            placeholder="0x..."
            aria-label="Wallet address"
          />
          <button onClick={() => window.localStorage.setItem('perkosKnowledgeWallet', wallet)}>Unlock</button>
        </div>
        <p className="mutedSmall">Allowed wallet: <code>{allowedWallet}</code></p>
      </section>
    </main>
  );
}
