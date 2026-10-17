import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { crearApp } from '../src/server.js';
import { crearMpSimulado, firmar, verificarFirma } from '../src/mp.js';
import { nuevoEntorno } from './helpers.js';

let pool, mp, server, base;
const SECRETO = 'secreto-de-prueba';

before(async () => {
  ({ pool, mp } = await nuevoEntorno());
  // Puerto libre elegido de antemano: el checkout simulado necesita conocer su propia URL.
  const sonda = createNetServer();
  await new Promise((r) => sonda.listen(0, '127.0.0.1', r));
  const puerto = sonda.address().port;
  await new Promise((r) => sonda.close(r));
  base = `http://127.0.0.1:${puerto}`;
  mp = crearMpSimulado({ baseUrl: base });
  server = crearApp({ pool, mp, config: { baseUrl: base, webhookSecret: SECRETO, panelKey: 'clave-panel' } });
  await new Promise((r) => server.listen(puerto, '127.0.0.1', r));
});
after(async () => { server.close(); await pool.end(); });

const post = (ruta, cuerpo, headers = {}) => fetch(base + ruta, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(cuerpo),
});

describe('flujo completo (Mercado Pago simulado)', () => {
  it('crear pago → pagar en el checkout simulado → webhook firmado → números asignados', async () => {
    const r = await post('/api/crear-pago', {
      nombre: 'Ana', whatsapp: '1166660000', cantidad: 2, modo: 'azar', codigoVendedor: 'leon12',
    });
    assert.equal(r.status, 201);
    const { ref, init_point, monto } = await r.json();
    assert.equal(monto, 40000);
    assert.match(init_point, /\/mock-mp\//);

    const antes = await (await fetch(`${base}/api/orden/${ref}`)).json();
    assert.equal(antes.estado, 'pendiente');

    const pago = await fetch(init_point, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'status=approved', redirect: 'manual',
    });
    assert.equal(pago.status, 303);

    const despues = await (await fetch(`${base}/api/orden/${ref}`)).json();
    assert.equal(despues.estado, 'pagada');
    assert.equal(despues.numeros.length, 2);

    const p = await (await fetch(`${base}/api/panel`, { headers: { 'x-panel-key': 'clave-panel' } })).json();
    assert.equal(p.vendidos, 2);
    assert.equal(p.porJugador[0].vendedor, 'Valentina Ruiz');
  });

  it('pago rechazado no asigna números', async () => {
    const { ref, init_point } = await (await post('/api/crear-pago', {
      nombre: 'Beto', whatsapp: '11', cantidad: 1, modo: 'azar',
    })).json();
    await fetch(init_point, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'status=rejected', redirect: 'manual',
    });
    assert.equal((await (await fetch(`${base}/api/orden/${ref}`)).json()).estado, 'pendiente');
  });

  it('un webhook sin firma válida se rechaza y no procesa nada', async () => {
    const { ref, monto } = await (await post('/api/crear-pago', { nombre: 'C', whatsapp: '1', cantidad: 1, modo: 'azar' })).json();
    const pid = mp.simularPago({ ref, amount: monto });
    const sinFirma = await post(`/api/mp-webhook?type=payment&data.id=${pid}`, {});
    assert.equal(sinFirma.status, 401);
    const mala = await post(`/api/mp-webhook?type=payment&data.id=${pid}`, {}, { 'x-signature': 'ts=1,v1=00', 'x-request-id': 'x' });
    assert.equal(mala.status, 401);
    assert.equal((await (await fetch(`${base}/api/orden/${ref}`)).json()).estado, 'pendiente');
    const buena = await post(`/api/mp-webhook?type=payment&data.id=${pid}`, {}, {
      'x-request-id': 'r1', 'x-signature': firmar({ secreto: SECRETO, requestId: 'r1', dataId: pid }),
    });
    assert.equal(buena.status, 200);
    assert.equal((await (await fetch(`${base}/api/orden/${ref}`)).json()).estado, 'pagada');
  });

  it('el panel exige clave', async () => {
    assert.equal((await fetch(`${base}/api/panel`)).status, 401);
    assert.equal((await fetch(`${base}/api/panel`, { headers: { 'x-panel-key': 'mala' } })).status, 401);
  });

  it('valida entradas: código inexistente, cantidad inválida, número ya reservado', async () => {
    const mal = await post('/api/crear-pago', { nombre: 'X', whatsapp: '1', cantidad: 1, modo: 'azar', codigoVendedor: 'ZZZ99' });
    assert.equal(mal.status, 400);
    assert.equal((await mal.json()).error, 'vendedor_invalido');
    const c = await post('/api/crear-pago', { nombre: 'X', whatsapp: '1', cantidad: 99, modo: 'azar' });
    assert.equal((await c.json()).error, 'cantidad_invalida');
    const a = await post('/api/crear-pago', { nombre: 'X', whatsapp: '1', cantidad: 1, modo: 'elegir', numeros: [321] });
    assert.equal(a.status, 201);
    const b = await post('/api/crear-pago', { nombre: 'Y', whatsapp: '1', cantidad: 1, modo: 'elegir', numeros: [321] });
    assert.equal((await b.json()).error, 'numeros_no_disponibles');
  });
});

describe('web y vendedores', () => {
  it('sirve la web en modo servidor', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /window\.RIFA_API = ""/);
    assert.match(html, /Rifa Solidaria Lomas/);
  });

  it('valida un código de vendedor y expone solo nombre y categoría', async () => {
    const ok = await fetch(`${base}/api/vendedor/%20tigre47`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { nombre: 'Mateo Gómez', categoria: 'M12' });
    assert.equal((await fetch(`${base}/api/vendedor/NOEXISTE1`)).status, 404);
  });

  it('frena el barrido de códigos (límite por minuto)', async () => {
    const rs = [];
    for (let i = 0; i < 40; i++) rs.push((await fetch(`${base}/api/vendedor/ZZZ${i}`)).status);
    assert.ok(rs.includes(429), 'después de 30 consultas por minuto responde 429');
  });

  it('el rechazo del checkout vuelve a la web marcado como rechazado', async () => {
    const { init_point } = await (await post('/api/crear-pago', { nombre: 'R', whatsapp: '1', cantidad: 1, modo: 'azar' })).json();
    const r = await fetch(init_point, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'status=rejected', redirect: 'manual',
    });
    assert.match(r.headers.get('location'), /^\/\?orden=ORD-[A-Z0-9]+&pago=rechazado$/);
  });
});

describe('firma del webhook', () => {
  it('acepta la firma correcta y rechaza una alterada', () => {
    const firma = firmar({ secreto: 's', requestId: 'r', dataId: '123' });
    assert.equal(verificarFirma({ secreto: 's', firma, requestId: 'r', dataId: '123' }), true);
    assert.equal(verificarFirma({ secreto: 's', firma, requestId: 'r', dataId: '124' }), false);
    assert.equal(verificarFirma({ secreto: 'otro', firma, requestId: 'r', dataId: '123' }), false);
    assert.equal(verificarFirma({ secreto: 's', firma: undefined, requestId: 'r', dataId: '123' }), false);
  });
});
