import { requireAdmin, publicOrganization, stableId } from '../../../../lib/admin';
import { withDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

type Body = {
  id?: string;
  name?: string;
  slug?: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const rows = await withDb(async (client) => {
    const res = await client.query(
      `SELECT id, name, slug, status, created_at, updated_at
       FROM organizations
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return res.rows;
  });

  return Response.json({ ok: true, count: rows.length, organizations: rows.map(publicOrganization) });
}

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const body = await request.json().catch(() => ({})) as Body;
  const name = String(body.name || '').trim();
  if (!name) return Response.json({ ok: false, error: 'name_required' }, { status: 400 });

  const id = String(body.id || stableId('org', body.slug || name)).trim();
  const slug = String(body.slug || id.replace(/^org_/, '')).trim().toLowerCase();
  const status = ['active', 'inactive'].includes(String(body.status)) ? String(body.status) : 'active';

  const organization = await withDb(async (client) => {
    const res = await client.query(
      `INSERT INTO organizations (id, name, slug, status, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         metadata = organizations.metadata || EXCLUDED.metadata,
         updated_at = now()
       RETURNING id, name, slug, status, created_at, updated_at`,
      [id, name, slug, status, body.metadata || {}]
    );
    return res.rows[0];
  });

  return Response.json({ ok: true, organization: publicOrganization(organization) });
}
