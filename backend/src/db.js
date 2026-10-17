import { readFileSync } from 'node:fs';
import pg from 'pg';

export function makePool(url = process.env.DATABASE_URL, max = 20) {
  if (!url) throw new Error('Falta DATABASE_URL');
  return new pg.Pool({ connectionString: url, max });
}

export async function aplicarEsquema(pool) {
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

// Ejecuta fn dentro de una transacción. Reintenta ante deadlock/serialización.
export async function tx(pool, fn, intentos = 4) {
  for (let i = 1; ; i++) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      try { await c.query('rollback'); } catch { /* conexión ya cerrada */ }
      if ((e.code === '40P01' || e.code === '40001') && i < intentos) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
