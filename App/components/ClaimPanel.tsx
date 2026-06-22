'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

// Minimal PerkosClaimVault ABI — the pieces the dashboard needs.
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

type ClaimData = {
  vaultAddress: string | null;
  usdcToken: string | null;
  perkosToken: string | null;
  chain: string;
  claim: { cumUsdc: string; cumReward: string; proof: string[]; root: string; posted: boolean } | null;
};

const CHAIN_IDS: Record<string, number> = { base: 8453, 'base-sepolia': 84532, basesepolia: 84532, sepolia: 84532 };
const btn: React.CSSProperties = { padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(124,247,200,0.4)', background: 'rgba(124,247,200,0.16)', color: 'inherit', cursor: 'pointer', fontSize: 14, fontWeight: 700 };

export default function ClaimPanel() {
  const { address } = useAccount();
  const [data, setData] = useState<ClaimData | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const r = await fetch(`/api/claims/${address}`, { cache: 'no-store' });
      const d = await r.json();
      setData(d?.ok ? d : null);
    } catch {
      setData(null);
    } finally {
      setLoaded(true);
    }
  }, [address]);

  useEffect(() => { load(); }, [load]);

  const vault = data?.vaultAddress as `0x${string}` | undefined;
  const chainId = data ? CHAIN_IDS[data.chain?.toLowerCase()] ?? 8453 : 8453;
  const hasVault = Boolean(vault);

  const { data: claimedUsdc } = useReadContract({
    abi: VAULT_ABI, address: vault, functionName: 'claimedUsdc', args: address ? [address] : undefined, chainId,
    query: { enabled: hasVault && Boolean(address) },
  });
  const { data: claimedReward } = useReadContract({
    abi: VAULT_ABI, address: vault, functionName: 'claimedReward', args: address ? [address] : undefined, chainId,
    query: { enabled: hasVault && Boolean(address) },
  });

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => { if (isSuccess) load(); }, [isSuccess, load]);

  if (!loaded) return null;

  const cumUsdc = data?.claim ? BigInt(data.claim.cumUsdc) : 0n;
  const cumReward = data?.claim ? BigInt(data.claim.cumReward) : 0n;
  const owedUsdc = cumUsdc > (claimedUsdc as bigint ?? 0n) ? cumUsdc - (claimedUsdc as bigint ?? 0n) : 0n;
  const owedReward = cumReward > (claimedReward as bigint ?? 0n) ? cumReward - (claimedReward as bigint ?? 0n) : 0n;
  const canClaim = hasVault && data?.claim && (owedUsdc > 0n || owedReward > 0n);

  const doClaim = () => {
    if (!vault || !address || !data?.claim) return;
    writeContract({
      abi: VAULT_ABI, address: vault, functionName: 'claim', chainId,
      args: [address, cumUsdc, cumReward, data.claim.proof as `0x${string}`[]],
    });
  };

  return (
    <section className="dashPanel wide" style={{ border: '1px solid rgba(124,247,200,0.25)' }}>
      <p className="eyebrow">Claim · pull your earnings + $PERKOS</p>
      <h2>Claimable</h2>

      {!hasVault ? (
        <p className="body">The claim vault isn&apos;t deployed yet — your earnings accrue and become claimable here once it&apos;s live.</p>
      ) : !data?.claim ? (
        <p className="body">Nothing to claim yet. When a distribution includes your wallet, your USDC earnings + $PERKOS reward show up here to pull on-chain.</p>
      ) : (
        <>
          <div className="metricsGrid" style={{ marginTop: 8 }}>
            <article className="metric"><span>USDC (payment)</span><strong>{formatUnits(owedUsdc, 6)} USDC</strong></article>
            <article className="metric"><span>$PERKOS (reward)</span><strong>{formatUnits(owedReward, 18)} PERKOS</strong></article>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14 }}>
            <button style={{ ...btn, opacity: canClaim && !isPending && !confirming ? 1 : 0.5 }} onClick={doClaim} disabled={!canClaim || isPending || confirming}>
              {isPending ? 'Confirm in wallet…' : confirming ? 'Claiming…' : canClaim ? 'Claim' : 'All claimed ✓'}
            </button>
            {!data.claim.posted ? <span className="body" style={{ fontSize: 12, opacity: 0.7 }}>Root pending on-chain post.</span> : null}
            {isSuccess ? <span className="body" style={{ fontSize: 12, color: '#5fd0a0' }}>Claimed ✓</span> : null}
            {writeError ? <span className="body" style={{ fontSize: 12, color: '#e0a05f' }}>{writeError.message.slice(0, 80)}</span> : null}
          </div>
        </>
      )}
    </section>
  );
}
