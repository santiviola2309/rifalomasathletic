import { aplicarEsquema, makePool } from '../src/db.js';

const pool = makePool();
await aplicarEsquema(pool);
console.log('Esquema aplicado.');
await pool.end();
