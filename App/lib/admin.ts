import crypto from 'crypto';
import { isAllowedWallet, normalizeWallet } from './auth';

export function isAdminRequest(request: Request) {
  const adminToken = process.env.KNOWLEDGE_ADMIN_TOKEN || '';
  const auth = request.headers.get('authorization') || '';
  if (adminToken && auth === `Bearer ${adminToken}`) return true;

  const wallet = normalizeWallet(request.headers.get('x-admin-wallet') || request.headers.get('x-agent-wallet'));
  return Boolean(wallet && isAllowedWallet(wallet));
}

export function requireAdmin(request: Request) {
  if (isAdminRequest(request)) return null;
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export function stableId(prefix: string, value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  if (normalized) return `${prefix}_${normalized}`.slice(0, 96);
  return `${prefix}_${crypto.randomUUID()}`;
}

export function hashValue(value?: string | null) {
  const text = (value || '').trim();
  if (!text) return null;
  return crypto.createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16);
}

export function publicAgent(row: Record<string, unknown>) {
  return {
    id: row.id,
    displayName: row.display_name,
    agentType: row.agent_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicOrganization(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
