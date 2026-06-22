'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

const VAULT_ABI = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'cumUsdc', type: 'uint256' },
      { name: 'cumReward', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'claimedUsdc', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimedReward', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

type Claim = { cumUsdc: string; cumReward: string; proof: string[]; root: string; posted: boolean } | null;
type ChainClaim = { chain: string; chainId: number; usdc: string; perkos: string; claim: Claim };

const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(124,247,200,0.4)', background: 'rgba(124,247,200,0.16)', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 700 };

export default function ClaimPanel() {
  const { address } = useAccount();
  const [vault, setVault] = useState<string | null>(null);
  const [chains, setChains] = useState<ChainClaim[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const r = await fetch(`/api/claims/${address}`, { cache: 'no-store' });
      const d = await r.json();
      if (d?.ok) { setVault(d.vaultAddress); setChains(d.chains || []); }
    } catch {
      /* ignore */
    } finally {
      setLoaded(true);
    }
  }, [address]);
  useEffect(() => { load(); }, [load]);

  if (!loaded) return null;
  const hasVault = Boolean(vault);
  const claimable = chains.filter((c) => c.claim);

  return (
    <section className="dashPanel wide" style={{ border: '1px solid rgba(124,247,200,0.25)' }}>
      <p className="eyebrow">Claim · pull your earnings + $PERKOS</p>
      <h2>Claimable</h2>
      {!hasVault ? (
        <p className="body">The claim vault isn&apos;t deployed yet — your earnings accrue and become claimable here once it&apos;s live.</p>
      ) : claimable.length === 0 ? (
        <p className="body">Nothing to claim yet. Earnings are paid out on the chain a consumer paid on; when a distribution includes you, each chain&apos;s claim shows here.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          {claimable.map((c) => (
            <ClaimChainRow key={c.chain} vault={vault as `0x${string}`} cc={c} account={address as `0x${string}`} onClaimed={load} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClaimChainRow({ vault, cc, account, onClaimed }: { vault: `0x${string}`; cc: ChainClaim; account: `0x${string}`; onClaimed: () => void }) {
  const cumUsdc = BigInt(cc.claim!.cumUsdc);
  const cumReward = BigInt(cc.claim!.cumReward);
  const { data: claimedUsdc } = useReadContract({ abi: VAULT_ABI, address: vault, functionName: 'claimedUsdc', args: [account], chainId: cc.chainId });
  const { data: claimedReward } = useReadContract({ abi: VAULT_ABI, address: vault, functionName: 'claimedReward', args: [account], chainId: cc.chainId });
  const cu = (claimedUsdc as bigint) ?? 0n;
  const cr = (claimedReward as bigint) ?? 0n;
  const owedUsdc = cumUsdc > cu ? cumUsdc - cu : 0n;
  const owedReward = cumReward > cr ? cumReward - cr : 0n;

  const { writeContract, data: tx, isPending, error } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: tx });
  useEffect(() => { if (isSuccess) onClaimed(); }, [isSuccess, onClaimed]);

  const canClaim = owedUsdc > 0n || owedReward > 0n;
  const doClaim = () =>
    writeContract({ abi: VAULT_ABI, address: vault, functionName: 'claim', chainId: cc.chainId, args: [account, cumUsdc, cumReward, cc.claim!.proof as `0x${string}`[]] });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ textTransform: 'capitalize', fontWeight: 700 }}>{cc.chain}</span>
        <span className="body" style={{ fontSize: 13 }}>{formatUnits(owedUsdc, 6)} USDC</span>
        <span className="body" style={{ fontSize: 13, opacity: 0.8 }}>{formatUnits(owedReward, 18)} PERKOS</span>
        {!cc.claim!.posted ? <span className="body" style={{ fontSize: 11, opacity: 0.6 }}>root pending on-chain</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {isSuccess ? <span className="body" style={{ fontSize: 12, color: '#5fd0a0' }}>Claimed ✓</span> : null}
        {error ? <span className="body" style={{ fontSize: 11, color: '#e0a05f' }}>{error.message.slice(0, 60)}</span> : null}
        <button style={{ ...btn, opacity: canClaim && !isPending && !confirming ? 1 : 0.5 }} onClick={doClaim} disabled={!canClaim || isPending || confirming}>
          {isPending ? 'Confirm…' : confirming ? 'Claiming…' : canClaim ? `Claim on ${cc.chain}` : 'Claimed ✓'}
        </button>
      </div>
    </div>
  );
}
