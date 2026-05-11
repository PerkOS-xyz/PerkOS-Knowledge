'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useDisconnect } from 'wagmi';
import { useWalletAccess } from './useWalletAccess';

export default function WalletGate({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const access = useWalletAccess(address);

  if (isConnected && access === 'allowed') return <>{children}</>;

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
          The dashboard menu unlocks after your connected wallet is verified against the server-side access list.
        </p>

        <div className="connectPanel">
          <ConnectButton />
          {isConnected && access === 'checking' ? (
            <p className="mutedSmall">Checking wallet access…</p>
          ) : null}
          {isConnected && access === 'denied' ? (
            <div className="walletWarning">
              <strong>Wallet not authorized</strong>
              <span>The connected wallet is not on the current access list.</span>
              <button type="button" onClick={() => disconnect()}>Disconnect</button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
