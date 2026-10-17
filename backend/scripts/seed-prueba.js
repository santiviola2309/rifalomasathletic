// Carga jugadores de EJEMPLO para probar. No usar con el padrón real.
import { aplicarEsquema, makePool } from '../src/db.js';

const pool = makePool();
await aplicarEsquema(pool);
await pool.query(
  `insert into jugadores (codigo, nombre, categoria) values
   ('TIGRE47', 'Mateo Gómez', 'M12'),
   ('LEON12', 'Valentina Ruiz', 'Juveniles M16'),
   ('CONDOR08', 'Lucas Pereyra', 'Primera')
   on conflict (codigo) do nothing`);
console.log('Jugadores de ejemplo cargados.');
await pool.end();
