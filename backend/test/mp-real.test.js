import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { elegirMp } from '../src/config.js';
import { ErrorMp, crearMpReal } from '../src/mp-real.js';

const TOKEN = 'TEST-1234567890-secreto';
const BASE = 'https://rifa.ejemplo.com';

// fetch falso: registra lo que se envía y responde lo que se le indica.
function fetchFalso(respuesta) {
  const llamadas = [];
  const impl = async (url, opts) => {
    llamadas.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = typeof respuesta === 'function' ? respuesta(url, opts) : respuesta;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  impl.llamadas = llamadas;
  return impl;
}

describe('adaptador real de Mercado Pago', () => {
  it('crea la preferencia con la referencia, el monto, el aviso y las vueltas correctas', async () => {
    const f = fetchFalso({ body: { id: 'PREF-1', init_point: 'https://mp.com/checkout/abc', sandbox_init_point: 'https://sandbox.mp.com/abc' } });
    const mp = crearMpReal({ accessToken: TOKEN, baseUrl: BASE, fetchImpl: f });
    const r = await mp.createPreference({
      ref: 'ORD-ABC12345', monto: 40000, titulo: 'Rifa (2)', expiraEn: '2026-11-02T15:10:00.000Z',
    });
    assert.deepEqual(r, { id: 'PREF-1', init_point: 'https://mp.com/checkout/abc' });

    const [c] = f.llamadas;
    assert.equal(c.url, 'https://api.mercadopago.com/checkout/preferences');
    assert.equal(c.opts.method, 'POST');
    assert.equal(c.opts.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.body.external_reference, 'ORD-ABC12345');
    assert.equal(c.body.items[0].unit_price, 40000);
    assert.equal(c.body.items[0].quantity, 1);
    assert.equal(c.body.items[0].currency_id, 'ARS');
    assert.equal(c.body.notification_url, `${BASE}/api/mp-webhook`);
    assert.equal(c.body.back_urls.success, `${BASE}/?orden=ORD-ABC12345`);
    assert.equal(c.body.back_urls.failure, `${BASE}/?orden=ORD-ABC12345&pago=rechazado`);
    assert.equal(c.body.auto_return, 'approved');
    assert.equal(c.body.expiration_date_to, '2026-11-02T15:10:00.000Z');
  });

  it('usa el link sandbox si se lo pide', async () => {
    const f = fetchFalso({ body: { id: 'P', init_point: 'https://mp.com/real', sandbox_init_point: 'https://sandbox.mp.com/x' } });
    const mp = crearMpReal({ accessToken: TOKEN, baseUrl: BASE, fetchImpl: f, usarSandbox: true });
    assert.equal((await mp.createPreference({ ref: 'R', monto: 1, titulo: 't' })).init_point, 'https://sandbox.mp.com/x');
  });

  it('consulta un pago y lo normaliza a la interfaz del sistema', async () => {
    const f = fetchFalso({ body: { id: 987654, status: 'approved', transaction_amount: 40000, external_reference: 'ORD-ABC12345', otro: 'x' } });
    const mp = crearMpReal({ accessToken: TOKEN, baseUrl: BASE, fetchImpl: f });
    assert.deepEqual(await mp.getPayment('987654'), {
      id: '987654', status: 'approved', amount: 40000, external_reference: 'ORD-ABC12345',
    });
    assert.equal(f.llamadas[0].url, 'https://api.mercadopago.com/v1/payments/987654');
    assert.equal(f.llamadas[0].opts.method, 'GET');
  });

  it('rechaza ids de pago que no son numéricos (no arma URLs raras)', async () => {
    const f = fetchFalso({ body: {} });
    const mp = crearMpReal({ accessToken: TOKEN, baseUrl: BASE, fetchImpl: f });
    await assert.rejects(mp.getPayment('../../users/me'), ErrorMp);
    assert.equal(f.llamadas.length, 0);
  });

  it('un error de Mercado Pago nunca filtra el token', async () => {
    const f = fetchFalso({ status: 401, body: { message: 'invalid access token' } });
    const mp = crearMpReal({ accessToken: TOKEN, baseUrl: BASE, fetchImpl: f });
    await assert.rejects(mp.createPreference({ ref: 'R', monto: 1, titulo: 't' }), (e) => {
      assert.ok(e instanceof ErrorMp);
      assert.equal(e.estado, 401);
      assert.ok(!e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN));
      return true;
    });
  });

  it('si no hay red, falla con un error propio y sin el token', async () => {
    const f = async () => { throw new TypeError('fetch failed'); };
    const mp = crearMpReal({ accessToken: TOKEN, baseUrl: BASE, fetchImpl: f });
    await assert.rejects(mp.getPayment('1'), (e) => e instanceof ErrorMp && e.estado === 0 && !e.message.includes(TOKEN));
  });
});

describe('modos y credenciales (no cobrar de verdad por error)', () => {
  it('simulado es el modo por defecto y no pide credenciales', () => {
    const c = elegirMp({ PORT: '3000' });
    assert.equal(c.modo, 'simulado');
    assert.equal(typeof c.mp.simularPago, 'function');
  });

  it('prueba exige un token TEST-: uno de producción no arranca', () => {
    assert.throws(() => elegirMp({ MP_MODO: 'prueba', MP_ACCESS_TOKEN: 'APP_USR-123-real' }), /PRUEBA/);
    assert.throws(() => elegirMp({ MP_MODO: 'prueba' }), /requiere MP_ACCESS_TOKEN/);
    const c = elegirMp({ MP_MODO: 'prueba', MP_ACCESS_TOKEN: TOKEN, BASE_URL: BASE });
    assert.equal(c.modo, 'prueba');
    assert.equal(c.mp.simularPago, undefined, 'no hay atajos de prueba en el adaptador real');
  });

  it('produccion rechaza token de prueba y exige todo lo necesario', () => {
    const completo = {
      MP_MODO: 'produccion', MP_ACCESS_TOKEN: 'APP_USR-123-real', BASE_URL: BASE,
      PANEL_KEY: 'k', MP_WEBHOOK_SECRET: 's', RIFA_AUTORIZACION_NRO: 'Res. 123/2026',
    };
    assert.equal(elegirMp(completo).modo, 'produccion');
    assert.throws(() => elegirMp({ ...completo, MP_ACCESS_TOKEN: TOKEN }), /es de prueba/);
    for (const falta of ['PANEL_KEY', 'MP_WEBHOOK_SECRET', 'RIFA_AUTORIZACION_NRO']) {
      assert.throws(() => elegirMp({ ...completo, [falta]: '' }), new RegExp(falta));
    }
    assert.throws(() => elegirMp({ ...completo, BASE_URL: 'http://rifa.ejemplo.com' }), /https/);
  });

  it('un modo desconocido no arranca', () => {
    assert.throws(() => elegirMp({ MP_MODO: 'real' }), /inválido/);
  });
});
