import { tx } from './db.js';

// Herramienta para borrar las compras de prueba antes de abrir la venta real.
// Solo se usa a mano, desde scripts/limpiar-pruebas.js. No la llama el servidor.

const MIN_PROTEGIDA = 20;   // una orden pendiente más nueva que esto puede ser un pago en curso

export async function listarOrdenes(pool) {
  const r = await pool.query(
    `select o.ref, o.comprador_nombre as comprador, o.comprador_whatsapp as whatsapp, o.estado, o.monto,
            o.creada_en,
            coalesce((select array_agg(lpad(n.numero::text, 4, '0') order by n.numero)
                      from numeros n where n.orden_id = o.id and n.estado = 'vendido'), '{}') as numeros,
            coalesce((select json_agg(json_build_object('id', p.mp_payment_id, 'estado_mp', p.estado_mp,
                                                        'resultado', p.resultado, 'monto', p.monto))
                      from pagos p where p.orden_id = o.id), '[]'::json) as pagos
     from ordenes o order by o.creada_en`);
  return r.rows;
}

/**
 * Borra todas las órdenes salvo las de `conservar` (lista de refs) y libera sus números.
 * Sin `confirmar` solo informa qué haría (simulacro). Las órdenes pendientes muy recientes se
 * saltean, por si alguien está pagando justo ahora.
 */
export async function limpiarPruebas(pool, { conservar = [], confirmar = false } = {}) {
  const refs = [...new Set(conservar.map((x) => String(x).trim()).filter(Boolean))];
  if (!refs.length) throw new Error('Indicá al menos una compra a conservar (--conservar ORD-XXXX).');

  const todas = await listarOrdenes(pool);
  const existentes = new Set(todas.map((o) => o.ref));
  const faltan = refs.filter((r) => !existentes.has(r));
  if (faltan.length) throw new Error(`No existe la compra: ${faltan.join(', ')}. No se borró nada.`);

  const ahora = Date.now();
  const conservadas = todas.filter((o) => refs.includes(o.ref));
  const resto = todas.filter((o) => !refs.includes(o.ref));
  const protegidas = resto.filter((o) => o.estado === 'pendiente' && ahora - new Date(o.creada_en).getTime() < MIN_PROTEGIDA * 60_000);
  const aBorrar = resto.filter((o) => !protegidas.includes(o));
  const huerfanos = (await pool.query('select count(*)::int n from pagos where orden_id is null')).rows[0].n;
  const informe = { confirmado: false, conservadas, aBorrar, protegidas, pagosSinOrden: huerfanos };
  if (!confirmar || !aBorrar.length) return informe;

  const ids = (await pool.query('select id from ordenes where ref = any($1)', [aBorrar.map((o) => o.ref)])).rows.map((r) => r.id);
  await tx(pool, async (c) => {
    await c.query(
      `update numeros set estado = 'libre', orden_id = null, reservado_hasta = null where orden_id = any($1)`, [ids]);
    await c.query('delete from notificaciones where orden_id = any($1)', [ids]);
    await c.query('delete from pagos where orden_id = any($1)', [ids]);
    await c.query('delete from ordenes where id = any($1)', [ids]);
  });
  return { ...informe, confirmado: true };
}
