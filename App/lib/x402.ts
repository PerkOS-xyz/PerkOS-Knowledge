import crypto from 'crypto';
import type { Client } from 'pg';
import type { AccessContext } from './access';

export type X402Policy = {
  mode: 'metered_free' | 'enforce';
  endpoint: string;
  price: {
    amount: string;
    currency: string;
    chain: string;
    token: string;
  };
  required: boolean;
};

export type X402Request = {
  receiptId: string | null;
  status: 'not_required' | 'metered' | 'received' | 'missing' | 'invalid';
  headerPresent: boolean;
  receipt: Record<string, unknown> | null;
};

function env(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

export function getX402Policy(endpoint = '/skill/query'): X402Policy {
  const mode = env('KNOWLEDGE_X402_MODE', 'metered_free') === 'enforce' ? 'enforce' : 'metered_free';
  const amount = env('KNOWLEDGE_X402_PRICE_AMOUNT', '0');
  return {
    mode,
    endpoint,
    price: {
      amount,
      currency: env('KNOWLEDGE_X402_CURRENCY', 'USDC'),
      chain: env('KNOWLEDGE_X402_CHAIN', 'base'),
      token: env('KNOWLEDGE_X402_TOKEN', 'not_configured'),
    },
    required: mode === 'enforce' && amount !== '0',
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

export function inspectX402Request(request: Request, policy = getX402Policy()): X402Request {
  const { raw, parsed } = extractReceipt(request);
  if (!policy.required && !raw) {
    return { receiptId: null, status: policy.mode === 'metered_free' ? 'metered' : 'not_required', headerPresent: false, receipt: null };
  }

  if (!raw) return { receiptId: null, status: 'missing', headerPresent: false, receipt: null };

  const receipt = parsed || { rawHash: crypto.createHash('sha256').update(raw).digest('hex') };
  const explicitId = typeof receipt.id === 'string' ? receipt.id : typeof receipt.receiptId === 'string' ? receipt.receiptId : null;
  const receiptId = explicitId || `x402_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;

  return {
    receiptId,
    status: parsed ? 'received' : 'invalid',
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
    required: policy.required,
    status: x402.status,
    receiptId: x402.receiptId,
    price: policy.price,
    enforcement: policy.required ? 'required' : 'not_enforced',
  };
}
