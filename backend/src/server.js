import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  EVENTO, MAX_CARTONES_POR_COMPRA, PREMIOS_EVENTO, PRECIO_CARTON, PRECIO_ENTRADA, TOTAL_CARTONES, leerPremios,
} from './evento.js';
import { aplicarEsquema, makePool } from './db.js';
import { elegirMp, exigirCuentaDePrueba } from './config.js';
import { firmar, verificarFirma } from './mp.js';
import {
  ErrorNegocio, cancelarCompra, cancelarOrden, conciliacion, crearOrden, eliminarCompra, estadoOrden,
  guardarPreferencia, liberarVencidas, panel, stock, procesarPago,
} from './orders.js';

// La web es un solo HTML. Al servirla desde acá se le avisa que hay servidor (modo API).
let htmlBase = null;
function paginaWeb(modo, premios = []) {
  htmlBase ??= readFileSync(new URL('../../web/bingo-balmoral.html', import.meta.url), 'utf8');
  const datos = {
    evento: EVENTO, precioEntrada: PRECIO_ENTRADA, precioCarton: PRECIO_CARTON, total: TOTAL_CARTONES,
    maxPorCompra: MAX_CARTONES_POR_COMPRA, premios,
  };
  const json = JSON.stringify(datos).replace(/</g, '\u003c');
  return htmlBase.replace('<body>', `<body><script>window.RIFA_API = ""; window.RIFA_MODO = ${JSON.stringify(modo)}; window.BINGO = ${json};</script>`);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function leerJson(req, max = 20_000) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > max) throw new ErrorNegocio('cuerpo_grande', 'Cuerpo demasiado grande.');
  }
  return data ? JSON.parse(data) : {};
}

const iguales = (a, b) => {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

// Límite simple por IP para que nadie bloquee los números creando órdenes en masa.
function limitador(maxPorMinuto) {
  const hits = new Map();
  return (ip) => {
    const ahora = Date.now();
    const lista = (hits.get(ip) ?? []).filter((t) => ahora - t < 60_000);
    lista.push(ahora); hits.set(ip, lista);
    return lista.length <= maxPorMinuto;
  };
}

/** Arma el servidor. `mp` es la interfaz de Mercado Pago (hoy: simulada). */
export function crearApp({ pool, mp, config = {} }) {
  const {
    baseUrl = 'http://localhost:3000',
    webhookSecret = null,        // si está, el webhook exige firma válida
    panelKey = null,             // si no está, el panel queda deshabilitado
    modo = 'simulado',
    premios = PREMIOS_EVENTO,    // premios que se muestran en la web (evento.js, o la variable PREMIOS)
    maxOrdenesPorMinuto = 10,
  } = config;
  const permitido = limitador(maxOrdenesPorMinuto);
  const permitidoStock = limitador(120);

  async function webhook(req, res, url) {
    const cuerpo = await leerJson(req).catch(() => ({}));
    const dataId = url.searchParams.get('data.id') ?? cuerpo?.data?.id ?? url.searchParams.get('id');
    const tipo = url.searchParams.get('type') ?? url.searchParams.get('topic') ?? cuerpo?.type;
    if (webhookSecret) {
      const ok = verificarFirma({
        secreto: webhookSecret, firma: req.headers['x-signature'],
        requestId: req.headers['x-request-id'], dataId,
      });
      if (!ok) return json(res, 401, { error: 'firma_invalida' });
    }
    if (tipo !== 'payment' || !dataId) return json(res, 200, { ignorado: true });
    try {
      const r = await procesarPago(pool, mp, dataId);
      return json(res, 200, r);
    } catch (e) {
      console.error('webhook', e);
      return json(res, 500, { error: 'reintentar' }); // MP vuelve a avisar
    }
  }

  async function crearPago(req, res) {
    const ip = req.socket.remoteAddress ?? '?';
    if (!permitido(ip)) return json(res, 429, { error: 'demasiados_intentos' });
    const b = await leerJson(req);
    const orden = await crearOrden(pool, {
      // Los cartones se asignan solo al azar: el servidor ignora cualquier pedido de elegir números.
      nombre: b.nombre, whatsapp: b.whatsapp, entradas: b.entradas, sueltos: b.sueltos, modo: 'azar',
    });
    try {
      const pref = await mp.createPreference({
        ref: orden.ref, monto: orden.monto, titulo: `${EVENTO.nombre} ${EVENTO.institucion} (${b.entradas} entradas, ${b.sueltos} cartones sueltos)`,
        expiraEn: orden.expiraEn,
      });
      await guardarPreferencia(pool, orden.id, pref.id);
      return json(res, 201, { ref: orden.ref, monto: orden.monto, init_point: pref.init_point, expiraEn: orden.expiraEn });
    } catch (e) {
      await cancelarOrden(pool, orden.id);
      throw e;
    }
  }

  // Pantalla de pago simulada (solo modo prueba): reemplaza al checkout de Mercado Pago.
  async function mockCheckout(req, res, url) {
    const ref = url.pathname.split('/')[2];
    const o = await estadoOrden(pool, ref);
    if (!o) return json(res, 404, { error: 'orden_inexistente' });
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Pago de prueba</title><body style="font:20px sans-serif;max-width:480px;margin:40px auto;padding:0 20px">
<p style="background:#f2c200;padding:8px;font-weight:700">MODO PRUEBA · no es Mercado Pago · no se cobra nada</p>
<h2>Pagar $${o.monto.toLocaleString('es-AR')}</h2><p>Orden ${o.ref}</p>
<form method=post><button name=status value=approved style="width:100%;min-height:64px;font:700 20px sans-serif;margin:8px 0">Aprobar pago</button>
<button name=status value=rejected style="width:100%;min-height:64px;font:700 20px sans-serif">Rechazar pago</button></form></body>`);
    }
    let data = ''; for await (const ch of req) data += ch;
    const status = new URLSearchParams(data).get('status') === 'approved' ? 'approved' : 'rejected';
    const pid = mp.simularPago({ ref, amount: o.monto, status });
    // Como haría Mercado Pago: avisa al webhook (con firma si está configurada).
    const rid = `req-${pid}`;
    const headers = { 'content-type': 'application/json', 'x-request-id': rid };
    if (webhookSecret) headers['x-signature'] = firmar({ secreto: webhookSecret, requestId: rid, dataId: pid });
    await fetch(`${baseUrl}/api/mp-webhook?type=payment&data.id=${pid}`, { method: 'POST', headers, body: '{}' });
    res.writeHead(303, { location: `/?orden=${ref}${status === 'approved' ? '' : '&pago=rechazado'}` });
    return res.end();
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(paginaWeb(modo, premios));
      }
      if (req.method === 'GET' && url.pathname === '/api/stock') {
        if (!permitidoStock(req.socket.remoteAddress ?? '?')) return json(res, 429, { error: 'demasiados_intentos' });
        return json(res, 200, await stock(pool));
      }
      if (req.method === 'POST' && url.pathname === '/api/crear-pago') return await crearPago(req, res);
      if (req.method === 'POST' && url.pathname === '/api/mp-webhook') return await webhook(req, res, url);
      if (req.method === 'POST' && (url.pathname === '/api/panel/cancelar' || url.pathname === '/api/panel/eliminar')) {
        if (!panelKey || !iguales(req.headers['x-panel-key'], panelKey)) return json(res, 401, { error: 'no_autorizado' });
        const b = await leerJson(req);
        return json(res, 200, url.pathname === '/api/panel/cancelar' ? await cancelarCompra(pool, b.ref) : await eliminarCompra(pool, b.ref));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/orden/')) {
        const o = await estadoOrden(pool, url.pathname.split('/')[3]);
        return o ? json(res, 200, o) : json(res, 404, { error: 'orden_inexistente' });
      }
      if (url.pathname.startsWith('/mock-mp/') && modo === 'simulado' && mp.simularPago) return await mockCheckout(req, res, url);
      if (req.method === 'GET' && (url.pathname === '/api/panel' || url.pathname === '/api/conciliacion')) {
        if (!panelKey || !iguales(req.headers['x-panel-key'], panelKey)) return json(res, 401, { error: 'no_autorizado' });
        return json(res, 200, url.pathname === '/api/panel' ? await panel(pool) : await conciliacion(pool));
      }
      return json(res, 404, { error: 'no_encontrado' });
    } catch (e) {
      if (e instanceof ErrorNegocio) return json(res, 400, { error: e.codigo, mensaje: e.message, ...e.extra });
      if (e instanceof SyntaxError) return json(res, 400, { error: 'json_invalido' });
      console.error(e);
      return json(res, 500, { error: 'error_interno' });
    }
  });
}

// Arranque: `npm start`. El modo lo decide MP_MODO (ver src/config.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  const puerto = Number(process.env.PORT ?? 3000);
  process.env.PORT = String(puerto);
  const { modo, baseUrl, mp, verificarCuenta, inicioToken } = elegirMp();
  if (verificarCuenta) await exigirCuentaDePrueba(mp, inicioToken);
  const pool = makePool();
  await aplicarEsquema(pool);
  // Defensa: si esta base ya tiene otra cantidad de números (por ejemplo, la de una rifa anterior), no arrancar.
  const hay = (await pool.query('select count(*)::int n from numeros')).rows[0].n;
  if (hay !== TOTAL_CARTONES) {
    console.error(`La base tiene ${hay} cartones y el bingo necesita ${TOTAL_CARTONES}. Usá una base de datos nueva para el bingo.`);
    process.exit(1);
  }
  const app = crearApp({
    pool, mp,
    config: {
      baseUrl, modo, webhookSecret: process.env.MP_WEBHOOK_SECRET || null, panelKey: process.env.PANEL_KEY || null,
      premios: leerPremios(process.env.PREMIOS).length ? leerPremios(process.env.PREMIOS) : PREMIOS_EVENTO,
    },
  });
  setInterval(() => liberarVencidas(pool).catch(console.error), 60_000).unref();
  app.listen(puerto, () => console.log(`Bingo en ${baseUrl} · modo ${modo.toUpperCase()} · entrada $${PRECIO_ENTRADA} · cartón $${PRECIO_CARTON}`));
}
