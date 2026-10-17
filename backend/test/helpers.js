import { aplicarEsquema, makePool } from '../src/db.js';
import { crearMpSimulado } from '../src/mp.js';

export const URL_PRUEBA = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/rifa_test';

export async function nuevoEntorno({ max = 60 } = {}) {
  const pool = makePool(URL_PRUEBA, max);
  await aplicarEsquema(pool);
  await pool.query('truncate pagos, notificaciones, numeros, ordenes, jugadores restart identity cascade');
  await pool.query(`insert into numeros (numero) select g from generate_series(1,1700) g`);
  await pool.query(
    `insert into jugadores (codigo, nombre, categoria) values
     ('TIGRE47','Mateo Gómez','M12'), ('LEON12','Valentina Ruiz','Juveniles M16'), ('CONDOR08','Lucas Pereyra','Primera')`);
  return { pool, mp: crearMpSimulado() };
}

export const comprador = (extra = {}) => ({
  nombre: 'Pepito Gamer', whatsapp: '1155550000', cantidad: 1, modo: 'azar', ...extra,
});

export const contar = async (pool, estado) =>
  (await pool.query('select count(*)::int n from numeros where estado = $1', [estado])).rows[0].n;
