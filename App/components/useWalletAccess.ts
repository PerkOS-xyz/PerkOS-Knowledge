'use client';

import { useEffect, useState } from 'react';

export type WalletAccess = 'idle' | 'checking' | 'allowed' | 'denied';

export function useWalletAccess(address?: string) {
  const [status, setStatus] = useState<WalletAccess>('idle');

  useEffect(() => {
    let active = true;

    if (!address) {
      setStatus('idle');
      return () => { active = false; };
    }

    setStatus('checking');
    fetch(`/api/access/${address}`, { cache: 'no-store' })
      .then((res) => {
        if (!active) return;
        setStatus(res.ok ? 'allowed' : 'denied');
      })
      .catch(() => {
        if (!active) return;
        setStatus('denied');
      });

    return () => { active = false; };
  }, [address]);

  return status;
}
