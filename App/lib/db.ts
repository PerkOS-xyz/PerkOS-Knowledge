import { Client } from 'pg';

type QueryValue = string | number | boolean | null | string[];

function connection() {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  };
}

export async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client(connection());
  await client.connect();
  try {
    await ensureSchema(client);
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function ensureSchema(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS research_items (
      id text PRIMARY KEY,
      source text NOT NULL,
      date text,
      track text,
      title text NOT NULL,
      path text NOT NULL,
      agents text[] NOT NULL DEFAULT '{}',
      chains text[] NOT NULL DEFAULT '{}',
      status text,
      confidence text,
      summary text,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_agents_idx ON research_items USING gin (agents)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_chains_idx ON research_items USING gin (chains)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_search_idx ON research_items USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(track,'') || ' ' || coalesce(path,'')))`);
}

export function normalizeValues(values: QueryValue[]) {
  return values;
}
