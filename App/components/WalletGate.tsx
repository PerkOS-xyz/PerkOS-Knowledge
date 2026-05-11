'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useDisconnect } from 'wagmi';
import { ALLOWED_WALLET, isAllowedWallet } from '../lib/auth';

export default function WalletGate({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const allowed = isAllowedWallet(address);

  if (isConnected && allowed) return <>{children}</>;

  return (
    <main className="dashShell">
      <nav className="dashNav">
        <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
        <ConnectButton />
      </nav>

      <section className="dashHero compact walletLogin">
        <p className="eyebrow">Wallet login</p>
        <h1>Connect your Knowledge wallet.</h1>
        <p className="lead">
          The dashboard menu unlocks after RainbowKit detects the allowlisted wallet. This preview uses wallet connection for access; signature-based auth can be added next.
        </p>

        <div className="connectPanel">
          <ConnectButton />
          {isConnected && !allowed ? (
            <div className="walletWarning">
              <strong>Wallet not allowlisted</strong>
              <span>Connected: <code>{address}</code></span>
              <span>Allowed: <code>{ALLOWED_WALLET}</code></span>
              <button type="button" onClick={() => disconnect()}>Disconnect</button>
            </div>
          ) : (
            <p className="mutedSmall">Allowed wallet: <code>{ALLOWED_WALLET}</code></p>
          )}
        </div>
      </section>
    </main>
  );
}
