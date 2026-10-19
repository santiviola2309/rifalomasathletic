import { randomBytes, randomUUID } from 'node:crypto';
import { tx } from './db.js';

export const PRECIO = 20000;
export const TOTAL_NUMEROS = 1700;
export const RESERVA_MIN = 10;
const MAX_POR_ORDEN = 20;

export class ErrorNegocio extends Error {
  constructor(codigo, mensaje, extra = {}) {
    super(mensaje);
    this.codigo = codigo;
    this.extra = extra;
  }
}

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevaRef() {
  let s = '';
  for (const b of randomBytes(8)) s += ALFABETO[b % ALFABETO.length];
  return `ORD-${s}`;
}


// Categorías del club desde infantiles hasta plantel superior.
export const CATEGORIAS = ['M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M19',
  'Primera', 'Intermedia', 'Pre-A', 'Pre-B', 'Pre-C'];

export const normalizarNombre = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
// "mateo GÓMEZ" -> "Mateo Gómez" (las partículas de, del, la… quedan en minúscula).
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'di', 'van', 'von']);
export const formatearNombre = (v) => normalizarNombre(v).split(' ').map((p, i) => {
  const m = p.toLowerCase();
  return i > 0 && PARTICULAS.has(m) ? m : m.charAt(0).toUpperCase() + m.slice(1);
}).join(' ');
// Clave para agrupar ventas: sin tildes, sin mayúsculas, sin espacios repetidos.
export const claveNombre = (v) =>
  normalizarNombre(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const PALABRA_NOMBRE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ'.-]*$/;
// Nombre completo: al menos dos palabras de 2 letras o más (nombre y apellido).
export function nombreCompletoValido(v) {
  const n = normalizarNombre(v);
  if (!n || n.length > 80) return false;
  const palabras = n.split(' ');
  return palabras.length >= 2 && palabras.every(
    (p) => PALABRA_NOMBRE.test(p) && p.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '').length >= 2);
}

// Números libres: sin dueño, o reservados con la reserva vencida.
const DISPONIBLE = `(estado = 'libre' or (estado = 'reservado' and reservado_hasta < now()))`;

// Toma n números al azar bloqueando las filas; las que otra transacción ya
// tiene bloqueadas se saltean (no hay esperas ni deadlocks).
async function tomarAzar(c, n, excluir = []) {
  const tomados = [];
  for (let intento = 0; tomados.length < n && intento < 6; intento++) {
    const r = await c.query(
      `select numero from numeros where ${DISPONIBLE} and numero <> all($2::smallint[])
       order by random() limit $1 for update skip locked`,
      [n - tomados.length, [...excluir, ...tomados]],
    );
    tomados.push(...r.rows.map((x) => x.numero));
  }
  return tomados;
}

// Bloquea, en orden ascendente (evita deadlocks), los números pedidos que sigan disponibles.
async function tomarElegidos(c, lista) {
  const r = await c.query(
    `select numero from numeros where numero = any($1::smallint[]) and ${DISPONIBLE}
     order by numero for update`,
    [lista],
  );
  return r.rows.map((x) => x.numero);
}

/**
 * Devuelve el celular en formato internacional de Argentina (549 + área + número) o null si no
 * puede ser un celular argentino: código de área + número, sin 0 ni 15, 10 dígitos en total.
 * Misma regla que usa la web (waNumero), para que ambos lados coincidan.
 */
export function normalizarWhatsapp(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54') && d.length >= 12) { d = d.slice(2); if (d.startsWith('9')) d = d.slice(1); }
  d = d.replace(/^0+/, '');
  if (d.length === 12) {   // código de área + 15 + número (formato viejo)
    for (let a = 2; a <= 4; a++) { if (d.substr(a, 2) === '15') { d = d.slice(0, a) + d.slice(a + 2); break; } }
  }
  if (d.length !== 10 || /^(\d)\1{9}$/.test(d) || d.startsWith('0')) return null;
  return `549${d}`;
}

function validarEntrada({ nombre, whatsapp, cantidad, modo, numeros, vendedorNombre, vendedorCategoria }) {
  if (!String(nombre ?? '').trim() || !String(whatsapp ?? '').trim()) {
    throw new ErrorNegocio('datos_incompletos', 'Falta el nombre o el WhatsApp.');
  }
  if (!normalizarWhatsapp(whatsapp)) {
    throw new ErrorNegocio('whatsapp_invalido',
      'Revisá tu WhatsApp: código de área y número, sin 0 ni 15. Por ejemplo: 11 5555-1234.');
  }
  if (!nombreCompletoValido(vendedorNombre)) {
    throw new ErrorNegocio('vendedor_nombre_invalido',
      'Escribí el nombre completo del jugador que te vendió (nombre y apellido).');
  }
  if (!CATEGORIAS.includes(vendedorCategoria)) {
    throw new ErrorNegocio('vendedor_categoria_invalida', 'Elegí la categoría del jugador.');
  }
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_POR_ORDEN) {
    throw new ErrorNegocio('cantidad_invalida', `La cantidad va de 1 a ${MAX_POR_ORDEN}.`);
  }
  if (modo !== 'azar' && modo !== 'elegir') throw new ErrorNegocio('modo_invalido', 'Modo inválido.');
  if (modo === 'elegir') {
    if (!Array.isArray(numeros) || numeros.length !== cantidad) {
      throw new ErrorNegocio('numeros_invalidos', 'La cantidad de números elegidos no coincide.');
    }
    const vistos = new Set();
    for (const n of numeros) {
      if (!Number.isInteger(n) || n < 1 || n > TOTAL_NUMEROS) {
        throw new ErrorNegocio('numeros_invalidos', `Los números van de 0001 a ${TOTAL_NUMEROS}.`);
      }
      if (vistos.has(n)) {
        throw new ErrorNegocio('numeros_repetidos', `Repetiste el ${String(n).padStart(4, '0')}.`);
      }
      vistos.add(n);
    }
  }
}

// Crea la orden y reserva los números (azar o elegidos) por RESERVA_MIN minutos.
export async function crearOrden(pool, entrada) {
  validarEntrada(entrada);
  const { nombre, whatsapp, cantidad, modo } = entrada;
  const numeros = modo === 'elegir' ? [...entrada.numeros].sort((a, b) => a - b) : null;
  const vendedor = formatearNombre(entrada.vendedorNombre);
  const clave = claveNombre(entrada.vendedorNombre);

  return tx(pool, async (c) => {
    const id = randomUUID();
    const ref = nuevaRef();
    const monto = cantidad * PRECIO;
    await c.query(
      `insert into ordenes (id, ref, comprador_nombre, comprador_whatsapp, cantidad, modo,
                            numeros_elegidos, vendedor_nombre, vendedor_categoria, vendedor_clave,
                            monto, expira_en)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(mins => $12))`,
      [id, ref, nombre.trim(), whatsapp.trim(), cantidad, modo, numeros, vendedor,
        entrada.vendedorCategoria, clave, monto, RESERVA_MIN],
    );

    let reservados;
    if (modo === 'elegir') {
      reservados = await tomarElegidos(c, numeros);
      if (reservados.length !== cantidad) {
        const ok = new Set(reservados);
        const no = numeros.filter((n) => !ok.has(n)).map((n) => String(n).padStart(4, '0'));
        throw new ErrorNegocio('numeros_no_disponibles', `No están disponibles: ${no.join(', ')}.`, { no });
      }
    } else {
      reservados = await tomarAzar(c, cantidad);
      if (reservados.length !== cantidad) {
        throw new ErrorNegocio('sin_stock', 'No quedan números disponibles por ahora.');
      }
    }
    await c.query(
      `update numeros set estado = 'reservado', orden_id = $1,
              reservado_hasta = now() + make_interval(mins => $2)
       where numero = any($3::smallint[])`,
      [id, RESERVA_MIN, reservados],
    );
    const exp = await c.query('select expira_en from ordenes where id = $1', [id]);
    return { id, ref, monto, expiraEn: exp.rows[0].expira_en };
  });
}

export async function guardarPreferencia(pool, ordenId, preferenciaId) {
  await pool.query('update ordenes set mp_preference_id = $2 where id = $1', [ordenId, preferenciaId]);
}

// Si el pago no se pudo iniciar (falla de Mercado Pago), se libera la reserva.
export async function cancelarOrden(pool, ordenId) {
  await tx(pool, async (c) => {
    const o = await c.query('select estado from ordenes where id = $1 for update', [ordenId]);
    if (o.rows[0]?.estado !== 'pendiente') return;
    await c.query(
      `update numeros set estado = 'libre', orden_id = null, reservado_hasta = null
       where orden_id = $1 and estado = 'reservado'`, [ordenId]);
    await c.query(`update ordenes set estado = 'vencida' where id = $1`, [ordenId]);
  });
}

// Libera reservas vencidas. Se corre cada minuto.
export async function liberarVencidas(pool) {
  return tx(pool, async (c) => {
    const n = await c.query(
      `update numeros set estado = 'libre', orden_id = null, reservado_hasta = null
       where estado = 'reservado' and reservado_hasta < now()`);
    const o = await c.query(
      `update ordenes set estado = 'vencida' where estado = 'pendiente' and expira_en < now()`);
    return { numeros: n.rowCount, ordenes: o.rowCount };
  });
}

// ---------------------------------------------------------------------------
// Confirmación de pagos
// ---------------------------------------------------------------------------

const FINALES = ['asignado', 'requiere_reembolso', 'sin_orden', 'monto_distinto'];

// Consigue los números de la orden al acreditarse el pago. Devuelve la lista o null.
async function conseguirNumeros(c, ord) {
  const mios = await c.query(
    `select numero from numeros where orden_id = $1 and estado = 'reservado'
     order by numero for update`, [ord.id]);
  let tengo = mios.rows.map((r) => r.numero);

  if (ord.modo === 'elegir') {
    const faltan = ord.numeros_elegidos.filter((n) => !tengo.includes(n));
    if (faltan.length) {
      const re = await tomarElegidos(c, faltan);
      if (re.length !== faltan.length) return null;
      tengo = tengo.concat(re);
    }
  } else if (tengo.length < ord.cantidad) {
    const extra = await tomarAzar(c, ord.cantidad - tengo.length, tengo);
    if (tengo.length + extra.length < ord.cantidad) return null;
    tengo = tengo.concat(extra);
  }
  return tengo.sort((a, b) => a - b);
}

/**
 * Procesa el aviso de un pago de Mercado Pago. Es seguro llamarlo muchas veces,
 * y en paralelo, para el mismo pago:
 *  - el pago se consulta a la API de MP (no se confía en lo que llega en el aviso)
 *  - la orden se identifica SOLO por external_reference
 *  - un pago de MP (mp_payment_id) se registra una sola vez
 *  - una orden acepta como máximo un pago asignado
 */
export async function procesarPago(pool, mp, paymentId) {
  const p = await mp.getPayment(paymentId);
  const pid = String(p.id);

  return tx(pool, async (c) => {
    // Serializa todo lo que toque este mismo pago.
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`pago:${pid}`]);

    const previo = (await c.query('select * from pagos where mp_payment_id = $1 for update', [pid])).rows[0];
    if (previo && FINALES.includes(previo.resultado)) {
      if (previo.estado_mp !== p.status) {
        await c.query(
          `update pagos set estado_mp = $2, actualizado_en = now(),
                  detalle = coalesce(detalle,'') || ' | estado en MP cambió a ' || $2
           where mp_payment_id = $1`, [pid, p.status]);
      }
      return { resultado: previo.resultado, repetido: true };
    }

    const ord = p.external_reference
      ? (await c.query('select * from ordenes where ref = $1 for update', [p.external_reference])).rows[0]
      : undefined;

    const guardar = (resultado, detalle = null) => c.query(
      `insert into pagos (mp_payment_id, orden_id, external_reference, estado_mp, monto, resultado, detalle)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (mp_payment_id) do update
         set orden_id = excluded.orden_id, estado_mp = excluded.estado_mp, monto = excluded.monto,
             resultado = excluded.resultado, detalle = excluded.detalle, actualizado_en = now()`,
      [pid, ord?.id ?? null, p.external_reference ?? null, p.status, Math.round(Number(p.amount)), resultado, detalle]);

    if (p.status !== 'approved') {
      await guardar('no_aprobado', p.status);
      return { resultado: 'no_aprobado' };
    }
    if (!ord) {
      await guardar('sin_orden', 'external_reference desconocida');
      return { resultado: 'sin_orden' };
    }
    if (Number(p.amount) !== ord.monto) {
      await guardar('monto_distinto', `pagó ${p.amount}, la orden vale ${ord.monto}`);
      return { resultado: 'monto_distinto' };
    }
    if (ord.estado === 'pagada' || ord.estado === 'requiere_reembolso' || ord.estado === 'cancelada') {
      await guardar('requiere_reembolso', `la orden ya estaba ${ord.estado}`);
      return { resultado: 'requiere_reembolso' };
    }

    const numeros = await conseguirNumeros(c, ord);
    if (!numeros) {
      await c.query(
        `update numeros set estado = 'libre', orden_id = null, reservado_hasta = null
         where orden_id = $1 and estado = 'reservado'`, [ord.id]);
      await c.query(`update ordenes set estado = 'requiere_reembolso' where id = $1`, [ord.id]);
      await guardar('requiere_reembolso', 'no quedaron números disponibles');
      return { resultado: 'requiere_reembolso' };
    }

    await c.query(
      `update numeros set estado = 'vendido', orden_id = $1, reservado_hasta = null
       where numero = any($2::smallint[])`, [ord.id, numeros]);
    await c.query(`update ordenes set estado = 'pagada', pagada_en = now() where id = $1`, [ord.id]);
    await guardar('asignado');

    const vend = ord.vendedor_nombre
      ? { nombre: ord.vendedor_nombre, categoria: ord.vendedor_categoria }
      : null;
    await c.query(
      `insert into notificaciones (orden_id, tipo, payload) values ($1, 'comprobante', $2)`,
      [ord.id, JSON.stringify({
        para: ord.comprador_whatsapp,
        comprador: ord.comprador_nombre,
        numeros: numeros.map((n) => String(n).padStart(4, '0')),
        vendedor: vend ? `${vend.nombre} (${vend.categoria})` : null,
      })]);
    return { resultado: 'asignado', numeros };
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export async function estadoOrden(pool, ref) {
  const o = (await pool.query('select * from ordenes where ref = $1', [ref])).rows[0];
  if (!o) return null;
  const out = { ref: o.ref, estado: o.estado, monto: o.monto, expiraEn: o.expira_en };
  if (o.estado === 'pagada') {
    const n = await pool.query(`select numero from numeros where orden_id = $1 and estado = 'vendido' order by numero`, [o.id]);
    out.numeros = n.rows.map((r) => String(r.numero).padStart(4, '0'));
  }
  return out;
}

export async function panel(pool) {
  const q = (sql, args) => pool.query(sql, args).then((r) => r.rows);
  const [tot] = await q(
    `select count(*)::int as vendidos, (count(*) * $1)::int as recaudado from numeros where estado = 'vendido'`, [PRECIO]);
  // Los datos viejos de pruebas (con código de jugador) se siguen mostrando gracias al join a jugadores.
  const VEND = `coalesce(o.vendedor_nombre, j.nombre, 'Sin vendedor')`;
  const CAT = `coalesce(o.vendedor_categoria, j.categoria, '—')`;
  const DESDE = `from numeros n join ordenes o on o.id = n.orden_id
     left join jugadores j on j.codigo = o.jugador_codigo where n.estado = 'vendido'`;
  const porJugador = await q(
    `select (array_agg(${VEND} order by length(regexp_replace(${VEND}, '[A-Za-z .''-]', '', 'g')) desc, o.creada_en desc))[1] as vendedor, ${CAT} as categoria, count(*)::int as numeros
     ${DESDE}
     group by coalesce(o.vendedor_clave, lower(j.nombre), ''), ${CAT} order by numeros desc, vendedor`);
  const porCategoria = await q(
    `select ${CAT} as categoria, count(*)::int as numeros ${DESDE} group by 1 order by numeros desc`);
  const ultimas = await q(
    `select lpad(n.numero::text, 4, '0') as numero, o.comprador_nombre as comprador,
            ${VEND} as vendedor, ${CAT} as categoria
     ${DESDE} order by o.creada_en desc, n.numero limit 30`);
  // Compras pagadas (para avisarles sus números por WhatsApp) y canceladas (para devolver el dinero).
  const compradores = await q(
    `select o.ref, o.comprador_nombre as comprador, o.comprador_whatsapp as whatsapp, o.estado, o.monto,
            case when o.estado = 'cancelada'
                 then coalesce((select array_agg(lpad(x::text, 4, '0') order by x) from unnest(o.numeros_anulados) x), '{}')
                 else coalesce((select array_agg(lpad(n.numero::text, 4, '0') order by n.numero)
                                from numeros n where n.orden_id = o.id and n.estado = 'vendido'), '{}') end as numeros,
            ${VEND} as vendedor, ${CAT} as categoria,
            coalesce(o.pagada_en, o.creada_en) as pagada_en, o.avisado_en, o.wsp_tocado_en, o.cancelada_en,
            (select p.mp_payment_id from pagos p where p.orden_id = o.id and p.resultado = 'asignado' limit 1) as pago_id,
            (select p.estado_mp from pagos p where p.orden_id = o.id and p.resultado = 'asignado' limit 1) as pago_estado
     from ordenes o left join jugadores j on j.codigo = o.jugador_codigo
     where o.estado in ('pagada', 'cancelada')
     order by coalesce(o.cancelada_en, o.pagada_en, o.creada_en) desc`);
  const sinAvisar = compradores.filter((c) => c.estado === 'pagada' && !c.avisado_en).length;
  return { ...tot, disponibles: TOTAL_NUMEROS - tot.vendidos, porJugador, porCategoria, ultimas, sinAvisar, compradores };
}

/**
 * Cancela una compra desde el panel: libera sus números y la deja registrada como 'cancelada'.
 * Si ya tenía un pago aprobado, `devolver` trae los datos para devolverlo desde Mercado Pago
 * (el sistema no mueve plata). Una compra cancelada no recibe números nunca más.
 */
export async function cancelarCompra(pool, ref) {
  return tx(pool, async (c) => {
    const o = (await c.query('select * from ordenes where ref = $1 for update', [String(ref ?? '')])).rows[0];
    if (!o) throw new ErrorNegocio('orden_inexistente', 'No encontramos esa compra.');
    const pago = (await c.query(
      `select mp_payment_id as id, estado_mp, monto from pagos where orden_id = $1 and resultado = 'asignado'`, [o.id])).rows[0] ?? null;
    const devolver = pago && pago.estado_mp === 'approved' ? pago : null;
    if (o.estado === 'cancelada') return { ref: o.ref, estado: 'cancelada', repetido: true, devolver };
    const nums = (await c.query('select numero from numeros where orden_id = $1 order by numero', [o.id])).rows.map((r) => r.numero);
    await c.query(
      `update numeros set estado = 'libre', orden_id = null, reservado_hasta = null where orden_id = $1`, [o.id]);
    await c.query(
      `update ordenes set estado = 'cancelada', cancelada_en = now(), numeros_anulados = $2 where id = $1`, [o.id, nums]);
    return { ref: o.ref, estado: 'cancelada', numeros: nums.map((n) => String(n).padStart(4, '0')), devolver };
  });
}

/** Borra por completo una compra YA cancelada (y sus avisos y pagos registrados). No se puede deshacer. */
export async function eliminarCompra(pool, ref) {
  return tx(pool, async (c) => {
    const o = (await c.query('select * from ordenes where ref = $1 for update', [String(ref ?? '')])).rows[0];
    if (!o) throw new ErrorNegocio('orden_inexistente', 'No encontramos esa compra.');
    if (o.estado !== 'cancelada') {
      throw new ErrorNegocio('primero_cancelar', 'Primero hay que cancelar la compra; después se puede eliminar.');
    }
    await c.query('delete from notificaciones where orden_id = $1', [o.id]);
    await c.query('delete from pagos where orden_id = $1', [o.id]);
    await c.query('delete from ordenes where id = $1', [o.id]);
    return { ref: o.ref, eliminada: true };
  });
}

/** Un organizador marca (o desmarca) que ya avisó a este comprador. Solo órdenes pagadas. */
export async function marcarAvisado(pool, ref, avisado = true) {
  const r = await pool.query(
    `update ordenes set avisado_en = case when $2 then now() else null end
     where ref = $1 and estado = 'pagada' returning avisado_en`, [String(ref ?? ''), !!avisado]);
  if (!r.rowCount) throw new ErrorNegocio('orden_inexistente', 'No encontramos esa compra.');
  return { ref, avisado_en: r.rows[0].avisado_en };
}

/** El comprador tocó su propio botón de WhatsApp. Solo deja constancia: no cuenta como aviso. */
export async function marcarWspTocado(pool, ref) {
  await pool.query(
    `update ordenes set wsp_tocado_en = coalesce(wsp_tocado_en, now())
     where ref = $1 and estado = 'pagada'`, [String(ref ?? '')]);
}

// Cruza órdenes, pagos y números. Todo en `problemas` debe ser cero.
export async function conciliacion(pool) {
  const q = (sql) => pool.query(sql).then((r) => r.rows);
  const vendidos = (await q(`select count(*)::int n from numeros where estado = 'vendido'`))[0].n;
  const esperados = (await q(`select coalesce(sum(cantidad),0)::int n from ordenes where estado = 'pagada'`))[0].n;
  const reembolsos = await q(
    `select mp_payment_id, external_reference, estado_mp, monto, resultado, detalle from pagos
     where resultado in ('requiere_reembolso','sin_orden','monto_distinto')
        or (resultado = 'asignado' and estado_mp <> 'approved')`);
  const pagadasSinPago = await q(
    `select o.ref from ordenes o where o.estado = 'pagada'
       and not exists (select 1 from pagos p where p.orden_id = o.id and p.resultado = 'asignado')`);
  const vendidosSinOrden = await q(
    `select n.numero from numeros n left join ordenes o on o.id = n.orden_id
     where n.estado = 'vendido' and (o.id is null or o.estado <> 'pagada')`);
  const pagadasSinNumeros = await q(
    `select o.ref from ordenes o where o.estado = 'pagada'
       and (select count(*) from numeros n where n.orden_id = o.id and n.estado = 'vendido') <> o.cantidad`);
  const canceladasConPago = await q(
    `select o.ref, p.mp_payment_id, p.monto from ordenes o join pagos p on p.orden_id = o.id and p.resultado = 'asignado'
     where o.estado = 'cancelada' and p.estado_mp = 'approved'`);
  return {
    coherente: vendidos === esperados && !pagadasSinPago.length && !vendidosSinOrden.length && !pagadasSinNumeros.length,
    vendidos, esperados,
    problemas: { reembolsos, pagadasSinPago, vendidosSinOrden, pagadasSinNumeros },
    reintegrosPendientes: canceladasConPago,
  };
}
