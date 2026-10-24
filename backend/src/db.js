import { readFileSync } from 'node:fs';
import pg from 'pg';

// Nombre de esquema seguro (se usa dentro de SQL): minúsculas, números y guion bajo.
export function esquemaValido(nombre) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(nombre)) {
    throw new Error(`DB_SCHEMA inválido: "${nombre}" (solo minúsculas, números y _)`);
  }
  return nombre;
}

/**
 * Con DB_SCHEMA (por ejemplo "bingo") todas las tablas viven en ese esquema dentro de la misma base:
 * así se puede reutilizar una base de Postgres que ya tiene datos de otro evento sin mezclarlos ni borrarlos.
 */
export function makePool(url = process.env.DATABASE_URL, max = 20, schema = process.env.DB_SCHEMA) {
  if (!url) throw new Error('Falta DATABASE_URL');
  const opciones = { connectionString: url, max };
  if (schema) opciones.options = `-c search_path=${esquemaValido(schema)}`;
  return new pg.Pool(opciones);
}

export async function aplicarEsquema(pool, schema = process.env.DB_SCHEMA) {
  if (schema) await pool.query(`create schema if not exists ${esquemaValido(schema)}`);
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
