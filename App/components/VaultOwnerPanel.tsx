'use client';

/**
 * Vault · owner ops — owner-only on-chain actions on the PerkosClaimVault,
 * signed from the connected wallet (no private key in a CLI / on the server).
 *
 * Renders ONLY when the connected wallet equals the vault `owner()` on-chain
 * (re-checked per render; the contract enforces `onlyOwner` regardless). The
 * one action today is `setRewardToken` — pointing each chain's vault at that
 * chain's $PERKOS so the 5% reward leg of a claim actually pays out. The vault
 * has the same address on every chain; each chain is set independently.
 *
 * Distributor ops (post Merkle root, fund the vault) are NOT here — those run
 * as the treasury/distributor wallet (0x3f0D…) via the operator scripts.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

const VAULT_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'rewardToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setRewardToken', stateMutability: 'nonpayable', inputs: [{ name: 'rewardToken_', type: 'address' }], outputs: [] },
] as const;

const ZERO = '0x0000000000000000000000000000000000000000';
const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(124,247,200,0.4)', background: 'rgba(124,247,200,0.16)', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 700 };

type ChainInfo = { chain: string; chainId: number; perkos: string };

export default function VaultOwnerPanel() {
  const { address } = useAccount();
  const [vault, setVault] = useState<string | null>(null);
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const r = await fetch(`/api/claims/${address}`, { cache: 'no-store' });
      const d = await r.json();
      if (d?.ok) {
        setVault(d.vaultAddress || null);
        setChains((d.chains || []).map((c: ChainInfo) => ({ chain: c.chain, chainId: c.chainId, perkos: c.perkos })));
      }
    } catch {
      /* ignore */
    } finally {
      setLoaded(true);
    }
  }, [address]);
  useEffect(() => { load(); }, [load]);

  // Owner is the same on every chain — read it on the first chain to gate visibility.
  const gate = chains.find((c) => c.chain === 'base') || chains[0];
  const { data: ownerData } = useReadContract({
    abi: VAULT_ABI,
    address: (vault as `0x${string}`) || undefined,
    functionName: 'owner',
    chainId: gate?.chainId,
    query: { enabled: Boolean(vault && gate) },
  });
  const isOwner = Boolean(address && ownerData && String(address).toLowerCase() === String(ownerData).toLowerCase());

  if (!loaded || !vault || !isOwner) return null;

  return (
    <section className="dashPanel wide" style={{ border: '1px solid rgba(124,247,200,0.25)' }}>
      <p className="eyebrow">Vault · owner ops</p>
      <h2>Reward token ($PERKOS)</h2>
      <p className="body" style={{ fontSize: 13, opacity: 0.8 }}>
        Point each chain&apos;s vault at that chain&apos;s $PERKOS so the 5% reward leg of a claim pays out. Owner-only; signed with your connected wallet.
      </p>
      <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
        {chains.map((c) => (
          <VaultChainRow key={c.chain} vault={vault as `0x${string}`} info={c} onDone={load} />
        ))}
      </div>
    </section>
  );
}

function VaultChainRow({ vault, info, onDone }: { vault: `0x${string}`; info: ChainInfo; onDone: () => void }) {
  const { data: current, refetch } = useReadContract({ abi: VAULT_ABI, address: vault, functionName: 'rewardToken', chainId: info.chainId });
  const cur = (current as string | undefined) || '';
  const isZero = !cur || cur.toLowerCase() === ZERO;
  const matches = Boolean(cur) && cur.toLowerCase() === info.perkos.toLowerCase();

  const { writeContract, data: tx, isPending, error } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: tx });
  useEffect(() => { if (isSuccess) { refetch(); onDone(); } }, [isSuccess, refetch, onDone]);

  const doSet = () =>
    writeContract({ abi: VAULT_ABI, address: vault, functionName: 'setRewardToken', chainId: info.chainId, args: [info.perkos as `0x${string}`] });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ textTransform: 'capitalize', fontWeight: 700 }}>{info.chain}</span>
        {matches ? (
          <span className="body" style={{ fontSize: 12, color: '#5fd0a0' }}>✓ $PERKOS set</span>
        ) : isZero ? (
          <span className="body" style={{ fontSize: 12, opacity: 0.7 }}>not set — reward leg off</span>
        ) : (
          <span className="body" style={{ fontSize: 11, color: '#e0a05f' }}>set to {cur.slice(0, 10)}… (≠ target)</span>
        )}
        <span className="body" style={{ fontSize: 11, opacity: 0.5 }}>target {info.perkos.slice(0, 8)}…{info.perkos.slice(-4)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {error ? <span className="body" style={{ fontSize: 11, color: '#e0a05f' }}>{error.message.slice(0, 50)}</span> : null}
        {!matches ? (
          <button style={{ ...btn, opacity: isPending || confirming ? 0.5 : 1 }} onClick={doSet} disabled={isPending || confirming}>
            {isPending ? 'Confirm…' : confirming ? 'Setting…' : `Set on ${info.chain}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
