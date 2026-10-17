import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { conciliacion, crearOrden, procesarPago } from '../src/orders.js';
import { comprador, contar, nuevoEntorno } from './helpers.js';

let pool, mp;
before(async () => { ({ pool, mp } = await nuevoEntorno({ max: 80 })); });
after(() => pool.end());

describe('simultaneidad', () => {
  it('100 compradores piden el mismo número a la vez: solo uno lo consigue', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 100 }, (_, i) =>
      crearOrden(pool, comprador({ nombre: `Comprador ${i}`, modo: 'elegir', cantidad: 1, numeros: [777] }))));
    const ok = rs.filter((r) => r.status === 'fulfilled');
    const no = rs.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(no.length, 99);
    assert.ok(no.every((r) => r.reason.codigo === 'numeros_no_disponibles'));
    const n = await pool.query('select count(*)::int c from numeros where numero = 777 and estado = $1', ['reservado']);
    assert.equal(n.rows[0].c, 1);
  });

  it('órdenes que piden números superpuestos en distinto orden no se traban ni duplican', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => {
      const base = [900, 901, 902, 903];
      const nums = i % 2 ? base : [...base].reverse();
      return crearOrden(pool, comprador({ modo: 'elegir', cantidad: 4, numeros: nums }));
    }));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => r.reason.codigo === 'numeros_no_disponibles'));
  });

  it('se venden los 1700 números en paralelo sin duplicados ni sobreventa', async () => {
    // Limpieza: dejamos la base como nueva para contar los 1700.
    await pool.query('truncate pagos, notificaciones, numeros, ordenes restart identity cascade');
    await pool.query('insert into numeros (numero) select g from generate_series(1,1700) g');

    const ordenes = await Promise.all(Array.from({ length: 340 }, (_, i) =>
      crearOrden(pool, comprador({ nombre: `C${i}`, cantidad: 5 }))));
    assert.equal(await contar(pool, 'reservado'), 1700);

    // Una orden más: ya no hay stock.
    await assert.rejects(crearOrden(pool, comprador()), (e) => e.codigo === 'sin_stock');

    // Los 340 pagos llegan a la vez, cada uno avisado 2 veces.
    const pids = ordenes.map((o) => mp.simularPago({ ref: o.ref, amount: o.monto }));
    const rs = await Promise.all([...pids, ...pids].map((pid) => procesarPago(pool, mp, pid)));
    assert.equal(rs.filter((r) => r.resultado === 'asignado' && !r.repetido).length, 340);

    assert.equal(await contar(pool, 'vendido'), 1700);
    assert.equal(await contar(pool, 'libre'), 0);
    const dup = await pool.query(
      `select numero from numeros group by numero having count(*) > 1`);
    assert.equal(dup.rowCount, 0);
    const porOrden = await pool.query(
      `select o.ref, count(*)::int n from ordenes o join numeros n on n.orden_id = o.id group by o.ref having count(*) <> 5`);
    assert.equal(porOrden.rowCount, 0, 'cada orden tiene exactamente 5 números');
    const c = await conciliacion(pool);
    assert.equal(c.coherente, true);
    assert.equal(c.problemas.reembolsos.length, 0);
  });

  it('con todo vendido, un pago tardío de una orden vencida va a reembolso y no vende un 1701', async () => {
    const huerfana = '00000000-0000-0000-0000-000000000001';
    await pool.query(
      `insert into ordenes (id, ref, comprador_nombre, comprador_whatsapp, cantidad, modo, monto, estado, expira_en)
       values ($1, 'ORD-TARDIA01', 'Tarde', '11', 2, 'azar', 40000, 'vencida', now() - interval '1 hour')`, [huerfana]);
    const r = await procesarPago(pool, mp, mp.simularPago({ ref: 'ORD-TARDIA01', amount: 40000 }));
    assert.equal(r.resultado, 'requiere_reembolso');
    assert.equal(await contar(pool, 'vendido'), 1700);
  });
});
