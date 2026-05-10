export async function GET() {
  return Response.json({
    ok: true,
    service: 'perkos-knowledge',
    surface: 'marketing',
    checks: { app: true },
    ts: new Date().toISOString()
  });
}
