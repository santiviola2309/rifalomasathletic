import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { conciliacion, crearOrden, estadoOrden, liberarVencidas, panel, procesarPago } from '../src/orders.js';
import { comprador, contar, nuevoEntorno } from './helpers.js';

let pool, mp;
before(async () => { ({ pool, mp } = await nuevoEntorno()); });
after(() => pool.end());

const pagar = (orden, extra = {}) =>
  mp.simularPago({ ref: orden.ref, amount: orden.monto, ...extra });

describe('asociación pago ↔ orden', () => {
  it('Pepito Gamer paga y Pepito Mamó no: solo la orden de Gamer se habilita', async () => {
    const gamer = await crearOrden(pool, comprador({ nombre: 'Pepito Gamer', cantidad: 2 }));
    const mamo = await crearOrden(pool, comprador({ nombre: 'Pepito Mamó', cantidad: 2 }));

    const r = await procesarPago(pool, mp, pagar(gamer));
    assert.equal(r.resultado, 'asignado');

    const g = await estadoOrden(pool, gamer.ref);
    const m = await estadoOrden(pool, mamo.ref);
    assert.equal(g.estado, 'pagada');
    assert.equal(g.numeros.length, 2);
    assert.equal(m.estado, 'pendiente');
    assert.equal(m.numeros, undefined);
    const vendidosMamo = await pool.query(
      `select count(*)::int n from numeros n join ordenes o on o.id = n.orden_id
       where o.ref = $1 and n.estado = 'vendido'`, [mamo.ref]);
    assert.equal(vendidosMamo.rows[0].n, 0);
  });

  it('un pago con referencia desconocida no habilita ninguna orden', async () => {
    const o = await crearOrden(pool, comprador());
    const r = await procesarPago(pool, mp, mp.simularPago({ ref: 'ORD-INEXISTE', amount: o.monto }));
    assert.equal(r.resultado, 'sin_orden');
    assert.equal((await estadoOrden(pool, o.ref)).estado, 'pendiente');
  });

  it('un pago sin referencia no habilita ninguna orden', async () => {
    const o = await crearOrden(pool, comprador());
    const r = await procesarPago(pool, mp, mp.simularPago({ ref: undefined, amount: o.monto }));
    assert.equal(r.resultado, 'sin_orden');
    assert.equal((await estadoOrden(pool, o.ref)).estado, 'pendiente');
  });

  it('un monto distinto al de la orden no asigna números', async () => {
    const o = await crearOrden(pool, comprador({ cantidad: 3 }));
    const r = await procesarPago(pool, mp, pagar(o, { amount: 20000 }));
    assert.equal(r.resultado, 'monto_distinto');
    assert.equal((await estadoOrden(pool, o.ref)).estado, 'pendiente');
  });

  it('pago pendiente o rechazado no asigna; si luego se aprueba, asigna una vez', async () => {
    const o = await crearOrden(pool, comprador());
    const pid = pagar(o, { status: 'pending' });
    assert.equal((await procesarPago(pool, mp, pid)).resultado, 'no_aprobado');
    assert.equal((await estadoOrden(pool, o.ref)).estado, 'pendiente');
    mp.cambiarEstado(pid, 'approved');
    assert.equal((await procesarPago(pool, mp, pid)).resultado, 'asignado');
    assert.equal((await estadoOrden(pool, o.ref)).estado, 'pagada');
  });
});

describe('pagos repetidos y simultáneos', () => {
  it('50 avisos simultáneos del mismo pago asignan una sola vez', async () => {
    const o = await crearOrden(pool, comprador({ cantidad: 4 }));
    const pid = pagar(o);
    const antes = await contar(pool, 'vendido');
    const rs = await Promise.all(Array.from({ length: 50 }, () => procesarPago(pool, mp, pid)));
    assert.equal(rs.filter((r) => r.resultado === 'asignado' && !r.repetido).length, 1);
    assert.equal(await contar(pool, 'vendido') - antes, 4);
    const filas = await pool.query('select count(*)::int n from pagos where mp_payment_id = $1', [pid]);
    assert.equal(filas.rows[0].n, 1);
    const notifs = await pool.query('select count(*)::int n from notificaciones where orden_id = (select id from ordenes where ref = $1)', [o.ref]);
    assert.equal(notifs.rows[0].n, 1, 'un solo comprobante');
  });

  it('dos pagos distintos para la misma orden: el segundo queda para reembolso', async () => {
    const o = await crearOrden(pool, comprador({ cantidad: 2 }));
    const p1 = pagar(o); const p2 = pagar(o);
    const antes = await contar(pool, 'vendido');
    const rs = await Promise.all([procesarPago(pool, mp, p1), procesarPago(pool, mp, p2)]);
    assert.deepEqual(rs.map((r) => r.resultado).sort(), ['asignado', 'requiere_reembolso']);
    assert.equal(await contar(pool, 'vendido') - antes, 2, 'solo 2 números, no 4');
    const c = await conciliacion(pool);
    assert.equal(c.problemas.reembolsos.length >= 1, true);
  });
});

describe('reservas y vencimiento', () => {
  it('si la reserva venció y el número lo tomó otro, el pago tardío va a reembolso', async () => {
    const a = await crearOrden(pool, comprador({ modo: 'elegir', cantidad: 1, numeros: [1500] }));
    await pool.query(`update numeros set reservado_hasta = now() - interval '1 minute' where numero = 1500`);
    await liberarVencidas(pool);
    const b = await crearOrden(pool, comprador({ nombre: 'Otro', modo: 'elegir', cantidad: 1, numeros: [1500] }));
    assert.equal((await procesarPago(pool, mp, pagar(b))).resultado, 'asignado');
    const tarde = await procesarPago(pool, mp, pagar(a));
    assert.equal(tarde.resultado, 'requiere_reembolso');
    assert.equal((await estadoOrden(pool, b.ref)).numeros[0], '1500');
  });

  it('si la reserva venció pero nadie tomó el número, el pago tardío igual se asigna', async () => {
    const a = await crearOrden(pool, comprador({ modo: 'elegir', cantidad: 1, numeros: [1499] }));
    await pool.query(`update numeros set reservado_hasta = now() - interval '1 minute' where numero = 1499`);
    await liberarVencidas(pool);
    assert.equal((await procesarPago(pool, mp, pagar(a))).resultado, 'asignado');
    assert.deepEqual((await estadoOrden(pool, a.ref)).numeros, ['1499']);
  });

  it('un pago al azar con reserva vencida consigue números nuevos sin repetir ninguno', async () => {
    const a = await crearOrden(pool, comprador({ cantidad: 5 }));
    await pool.query(
      `update numeros set reservado_hasta = now() - interval '1 minute'
       where orden_id = (select id from ordenes where ref = $1)`, [a.ref]);
    await liberarVencidas(pool);
    assert.equal((await procesarPago(pool, mp, pagar(a))).resultado, 'asignado');
    const nums = (await estadoOrden(pool, a.ref)).numeros;
    assert.equal(new Set(nums).size, 5);
  });
});

describe('vendedor', () => {
  it('asocia la venta al código del vendedor y rechaza códigos inexistentes', async () => {
    await assert.rejects(
      crearOrden(pool, comprador({ codigoVendedor: 'NOEXISTE99' })),
      (e) => e.codigo === 'vendedor_invalido');
    const o = await crearOrden(pool, comprador({ cantidad: 3, codigoVendedor: ' tigre47 ' }));
    await procesarPago(pool, mp, pagar(o));
    const sinV = await crearOrden(pool, comprador({ cantidad: 1 }));
    await procesarPago(pool, mp, pagar(sinV));
    const p = await panel(pool);
    const mateo = p.porJugador.find((x) => x.vendedor === 'Mateo Gómez');
    assert.equal(mateo.numeros, 3);
    assert.equal(mateo.categoria, 'M12');
    assert.ok(p.porJugador.find((x) => x.vendedor === 'Sin vendedor'));
    const notif = await pool.query(
      `select payload from notificaciones where orden_id = (select id from ordenes where ref = $1)`, [o.ref]);
    assert.match(notif.rows[0].payload.vendedor, /Mateo Gómez \(M12\)/);
  });
});

describe('conciliación', () => {
  it('después de todo lo anterior, ventas, pagos y números cierran', async () => {
    const c = await conciliacion(pool);
    assert.equal(c.coherente, true, JSON.stringify(c.problemas));
    assert.equal(c.vendidos, c.esperados);
  });
});
