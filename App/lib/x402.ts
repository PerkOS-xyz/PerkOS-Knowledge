import crypto from 'crypto';
import type { Client } from 'pg';
import type { AccessContext } from './access';

export type X402Tier = 'public' | 'private' | 'premium';

export type X402Policy = {
  mode: 'metered_free' | 'enforce';
  endpoint: string;
  tier: X402Tier;
  description: string;
  price: {
    amount: string;
    currency: string;
    chain: string;
    token: string;
  };
  required: boolean;
  paymentRequirements: {
    scheme: 'x402';
    network: string;
    asset: string;
    amount: string;
    payTo: string | null;
    resource: string;
    memo: string;
  } | null;
};

export type X402Request = {
  receiptId: string | null;
  status: 'not_required' | 'metered' | 'received' | 'missing' | 'invalid' | 'underpaid';
  headerPresent: boolean;
  receipt: Record<string, unknown> | null;
};

function env(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function boolEnv(name: string) {
  return ['1', 'true', 'yes', 'on'].includes(env(name, '').toLowerCase());
}

function tierAmount(tier: X402Tier) {
  if (tier === 'private') return env('KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT', env('KNOWLEDGE_X402_PRICE_AMOUNT', '0'));
  if (tier === 'premium') return env('KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT', env('KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT', env('KNOWLEDGE_X402_PRICE_AMOUNT', '0')));
  return env('KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT', env('KNOWLEDGE_X402_PRICE_AMOUNT', '0'));
}

export function resolveX402Tier(input?: { requestedTier?: string; hasOrganizationScope?: boolean; mode?: string }): X402Tier {
  const requested = String(input?.requestedTier || input?.mode || '').toLowerCase();
  if (requested === 'private' || requested === 'organization') return 'private';
  if (requested === 'premium' || requested === 'paid') return 'premium';
  return input?.hasOrganizationScope ? 'private' : 'public';
}

export function getX402Policy(endpoint = '/skill/query', tier: X402Tier = 'public'): X402Policy {
  const mode = env('KNOWLEDGE_X402_MODE', 'metered_free') === 'enforce' ? 'enforce' : 'metered_free';
  const amount = tierAmount(tier);
  const currency = env('KNOWLEDGE_X402_CURRENCY', 'USDC');
  const chain = env('KNOWLEDGE_X402_CHAIN', 'base');
  const token = env('KNOWLEDGE_X402_TOKEN', 'not_configured');
  const payTo = env('KNOWLEDGE_X402_PAY_TO', 'not_configured');
  const exposeSettlement = boolEnv('KNOWLEDGE_X402_EXPOSE_SETTLEMENT');
  const required = mode === 'enforce' && amount !== '0';

  return {
    mode,
    endpoint,
    tier,
    description: `${tier} knowledge query`,
    price: { amount, currency, chain, token },
    required,
    paymentRequirements: required ? {
      scheme: 'x402',
      network: chain,
      asset: exposeSettlement ? token : (token === 'not_configured' ? 'not_configured' : 'configured'),
      amount,
      payTo: exposeSettlement && payTo !== 'not_configured' ? payTo : null,
      resource: endpoint,
      memo: `PerkOS Knowledge ${tier} query`,
    } : null,
  };
}

function safeJson(input: string) {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractReceipt(request: Request) {
  const raw = request.headers.get('x-payment') || request.headers.get('x-x402-payment') || request.headers.get('x402-receipt') || '';
  if (!raw.trim()) return { raw: null, parsed: null };
  return { raw, parsed: safeJson(raw) };
}

function receiptAmount(receipt: Record<string, unknown> | null) {
  const value = receipt?.amount || receipt?.value || receipt?.paymentAmount;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return null;
}

export function inspectX402Request(request: Request, policy = getX402Policy()): X402Request {
  const { raw, parsed } = extractReceipt(request);
  if (!policy.required && !raw) {
    return { receiptId: null, status: policy.mode === 'metered_free' ? 'metered' : 'not_required', headerPresent: false, receipt: null };
  }

  if (!raw) return { receiptId: null, status: 'missing', headerPresent: false, receipt: null };

  const receipt = parsed || { rawHash: crypto.createHash('sha256').update(raw).digest('hex') };
  const explicitId = typeof receipt.id === 'string' ? receipt.id : typeof receipt.receiptId === 'string' ? receipt.receiptId : null;
  const receiptId = explicitId || `x402_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
  const paidAmount = receiptAmount(receipt);
  const expectedAmount = Number(policy.price.amount || 0);

  let status: X402Request['status'] = parsed ? 'received' : 'invalid';
  if (policy.required && parsed && paidAmount !== null && paidAmount < expectedAmount) status = 'underpaid';

  return {
    receiptId,
    status,
    headerPresent: true,
    receipt,
  };
}

export async function storeX402Receipt(client: Client, input: {
  x402: X402Request;
  policy: X402Policy;
  access: AccessContext;
  endpoint: string;
}) {
  if (!input.x402.receiptId) return null;

  await client.query(
    `INSERT INTO x402_receipts
      (id, consumer_agent_id, consumer_wallet, organization_id, endpoint, amount, chain, token, currency, raw, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       raw = EXCLUDED.raw,
       status = EXCLUDED.status`,
    [
      input.x402.receiptId,
      input.access.agentId,
      input.access.wallet,
      input.access.organizationIds[0] || null,
      input.endpoint,
      Number(input.policy.price.amount || 0),
      input.policy.price.chain,
      input.policy.price.token,
      input.policy.price.currency,
      {
        status: input.x402.status,
        headerPresent: input.x402.headerPresent,
        receipt: input.x402.receipt,
        policy: input.policy,
      },
      input.x402.status,
    ]
  );

  return input.x402.receiptId;
}

export function publicX402(policy: X402Policy, x402: X402Request) {
  return {
    mode: policy.mode,
    endpoint: policy.endpoint,
    tier: policy.tier,
    required: policy.required,
    status: x402.status,
    receiptId: x402.receiptId,
    price: {
      amount: policy.price.amount,
      currency: policy.price.currency,
      chain: policy.price.chain,
      token: policy.price.token === 'not_configured' ? 'not_configured' : 'configured',
    },
    paymentRequirements: policy.paymentRequirements,
    enforcement: policy.required ? 'required' : 'not_enforced',
  };
}
