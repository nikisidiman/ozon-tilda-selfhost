import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.js'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(text, params as any[])
  return r.rows
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params)
  return rows[0] ?? null
}

/** Применяет db/migrations/*.sql по порядку, каждую один раз, в транзакции. */
export async function migrate(dir: string): Promise<void> {
  await pool.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`)
  const done = new Set((await q<{ name: string }>('select name from schema_migrations')).map((r) => r.name))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (done.has(f)) continue
    const sql = await readFile(join(dir, f), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into schema_migrations(name) values ($1)', [f])
      await client.query('commit')
      console.log(`[db] миграция ${f} применена`)
    } catch (e) {
      await client.query('rollback')
      throw new Error(`Миграция ${f} не применилась: ${(e as Error).message}`)
    } finally {
      client.release()
    }
  }
}
