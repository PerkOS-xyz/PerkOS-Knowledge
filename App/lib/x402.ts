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
  verification: {
    facilitatorConfigured: boolean;
    required: boolean;
    timeoutMs: number;
  };
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

export type X402Status = 'not_required' | 'metered' | 'received' | 'missing' | 'invalid' | 'underpaid' | 'verified' | 'verification_failed' | 'facilitator_not_configured';

export type X402Request = {
  receiptId: string | null;
  status: X402Status;
  headerPresent: boolean;
  receipt: Record<string, unknown> | null;
  rawPayment?: string | null;
  verification?: Record<string, unknown> | null;
};

function env(name: string, fallback: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function boolEnv(name: string, fallback = false) {
  const value = env(name, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function numberEnv(name: string, fallback: number) {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  const facilitatorConfigured = env('KNOWLEDGE_X402_FACILITATOR_URL', '') !== '';

  return {
    mode,
    endpoint,
    tier,
    description: `${tier} knowledge query`,
    price: { amount, currency, chain, token },
    required,
    verification: {
      facilitatorConfigured,
      required: required && boolEnv('KNOWLEDGE_X402_REQUIRE_FACILITATOR', true),
      timeoutMs: numberEnv('KNOWLEDGE_X402_VERIFY_TIMEOUT_MS', 8000),
    },
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
    return { receiptId: null, status: policy.mode === 'metered_free' ? 'metered' : 'not_required', headerPresent: false, receipt: null, rawPayment: null };
  }

  if (!raw) return { receiptId: null, status: 'missing', headerPresent: false, receipt: null, rawPayment: null };

  const receipt = parsed || { rawHash: crypto.createHash('sha256').update(raw).digest('hex') };
  const explicitId = typeof receipt.id === 'string' ? receipt.id : typeof receipt.receiptId === 'string' ? receipt.receiptId : null;
  const receiptId = explicitId || `x402_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
  const paidAmount = receiptAmount(receipt);
  const expectedAmount = Number(policy.price.amount || 0);

  let status: X402Status = parsed ? 'received' : 'invalid';
  if (policy.required && parsed && paidAmount !== null && paidAmount < expectedAmount) status = 'underpaid';

  return {
    receiptId,
    status,
    headerPresent: true,
    receipt,
    rawPayment: raw,
  };
}

function verificationUrl() {
  return env('KNOWLEDGE_X402_FACILITATOR_URL', '').replace(/\/$/, '');
}

function facilitatorVerifyEndpoint() {
  const base = verificationUrl();
  if (!base) return null;
  const path = env('KNOWLEDGE_X402_FACILITATOR_VERIFY_PATH', '/verify');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function verifyX402WithFacilitator(x402: X402Request, policy: X402Policy): Promise<X402Request> {
  const endpoint = facilitatorVerifyEndpoint();
  if (!x402.headerPresent || !x402.rawPayment) return x402;
  if (x402.status !== 'received') return x402;
  if (!endpoint) {
    return policy.verification.required
      ? { ...x402, status: 'facilitator_not_configured', verification: { configured: false } }
      : x402;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.verification.timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        payment: x402.rawPayment,
        paymentHeader: x402.rawPayment,
        requirements: policy.paymentRequirements,
        policy: {
          endpoint: policy.endpoint,
          tier: policy.tier,
          amount: policy.price.amount,
          currency: policy.price.currency,
          chain: policy.price.chain,
        },
      }),
    });
    const data = await res.json().catch(() => ({ ok: false, status: res.status }));
    const valid = res.ok && (data.valid === true || data.ok === true || data.verified === true || data.isValid === true);
    const invalidReason = typeof data.invalidReason === 'string' ? data.invalidReason : typeof data.reason === 'string' ? data.reason : null;
    return {
      ...x402,
      status: valid ? 'verified' : 'verification_failed',
      verification: {
        httpStatus: res.status,
        valid,
        invalidReason,
        payerPresent: Boolean(data.payer),
        responseShape: {
          hasValid: typeof data.valid !== 'undefined',
          hasOk: typeof data.ok !== 'undefined',
          hasVerified: typeof data.verified !== 'undefined',
          hasIsValid: typeof data.isValid !== 'undefined',
          hasInvalidReason: typeof data.invalidReason !== 'undefined',
          hasPayer: typeof data.payer !== 'undefined',
        },
      },
    };
  } catch (error) {
    return {
      ...x402,
      status: 'verification_failed',
      verification: {
        error: error instanceof Error ? error.name : 'unknown_error',
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function isX402Satisfied(policy: X402Policy, x402: X402Request) {
  if (!policy.required) return true;
  if (policy.verification.required) return x402.status === 'verified';
  return x402.status === 'received' || x402.status === 'verified';
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
        verification: input.x402.verification,
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
    verification: {
      facilitatorConfigured: policy.verification.facilitatorConfigured,
      required: policy.verification.required,
      status: x402.verification ? x402.status : null,
    },
    paymentRequirements: policy.paymentRequirements,
    enforcement: policy.required ? 'required' : 'not_enforced',
  };
}
