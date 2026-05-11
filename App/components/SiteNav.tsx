'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { isAllowedWallet } from '../lib/auth';

export default function SiteNav() {
  const { address, isConnected } = useAccount();
  const allowed = isAllowedWallet(address);

  return (
    <nav className="nav siteNav">
      <a href="/" className="brand"><span className="orb" /> PerkOS Knowledge</a>
      <div className="navActions">
        {isConnected && allowed ? (
          <div className="headerMenu" aria-label="Authenticated navigation">
            <a href="/dashboard">Dashboard</a>
            <a href="/admin">Admin</a>
            <a href="/llms.txt">llms.txt</a>
            <a href="/healthz">Health</a>
          </div>
        ) : null}
        <ConnectButton />
      </div>
    </nav>
  );
}
