/**
 * Adaptador REAL de Mercado Pago (Checkout Pro). Misma interfaz que el simulado:
 *   createPreference({ ref, monto, titulo, expiraEn }) -> { id, init_point }
 *   getPayment(id)                                     -> { id, status, amount, external_reference }
 *
 * El dinero entra a la cuenta de Mercado Pago dueña del Access Token con el que se
 * crea la preferencia. El token se lee de MP_ACCESS_TOKEN (variable del servidor): nunca
 * va en el repo ni se escribe en logs ni en mensajes de error.
 *
 * Basado en la API de Checkout Pro (/checkout/preferences) y de pagos (/v1/payments/:id).
 * Confirmar los campos contra la documentación vigente de Mercado Pago antes de producción.
 */
const API = 'https://api.mercadopago.com';

export class ErrorMp extends Error {
  constructor(mensaje, estado) {
    super(mensaje);
    this.estado = estado;
  }
}

// Quita espacios, saltos de línea y comillas que se pegan sin querer junto con el token.
export const normalizarToken = (t) => String(t ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
export const esTokenDePrueba = (t) => /^TEST-/i.test(normalizarToken(t));

export function crearMpReal({
  accessToken,
  baseUrl,                       // URL pública (https) de este backend, para avisos y vueltas
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  usarSandbox = false,           // con credenciales de prueba algunas cuentas usan sandbox_init_point
} = {}) {
  if (!accessToken) throw new Error('Falta MP_ACCESS_TOKEN');
  if (!baseUrl) throw new Error('Falta la URL pública del backend (BASE_URL)');

  async function llamar(metodo, ruta, cuerpo) {
    let r;
    try {
      r = await fetchImpl(`${API}${ruta}`, {
        method: metodo,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ErrorMp(`No se pudo contactar a Mercado Pago (${e.name})`, 0);
    }
    const texto = await r.text();
    let datos = {};
    try { datos = texto ? JSON.parse(texto) : {}; } catch { /* respuesta no JSON */ }
    if (!r.ok) {
      // Nunca se incluye el token ni los encabezados en el error.
      throw new ErrorMp(`Mercado Pago respondió ${r.status}: ${datos.message ?? datos.error ?? 'error'}`, r.status);
    }
    return datos;
  }

  return {
    async createPreference({ ref, monto, titulo, expiraEn }) {
      const vuelta = (extra = '') => `${baseUrl}/?orden=${encodeURIComponent(ref)}${extra}`;
      const cuerpo = {
        items: [{ id: ref, title: titulo, quantity: 1, unit_price: monto, currency_id: 'ARS' }],
        external_reference: ref,
        notification_url: `${baseUrl}/api/mp-webhook`,
        back_urls: { success: vuelta(), pending: vuelta(), failure: vuelta('&pago=rechazado') },
        auto_return: 'approved',
        statement_descriptor: 'BINGO BALMORAL',
      };
      if (expiraEn) {
        cuerpo.expires = true;
        cuerpo.expiration_date_to = new Date(expiraEn).toISOString();
      }
      const d = await llamar('POST', '/checkout/preferences', cuerpo);
      const link = usarSandbox ? (d.sandbox_init_point ?? d.init_point) : d.init_point;
      if (!d.id || !link) throw new ErrorMp('Mercado Pago no devolvió el link de pago', 502);
      return { id: d.id, init_point: link };
    },

    // De quién es la credencial. Las cuentas de prueba de Mercado Pago tienen usuario TESTUSER…
    async getAccount() {
      const d = await llamar('GET', '/users/me');
      return { id: String(d.id ?? ''), nickname: String(d.nickname ?? '') };
    },

    async getPayment(id) {
      if (!/^\d+$/.test(String(id))) throw new ErrorMp('Id de pago inválido', 400);
      const d = await llamar('GET', `/v1/payments/${id}`);
      return {
        id: String(d.id),
        status: d.status,
        amount: d.transaction_amount,
        external_reference: d.external_reference ?? null,
      };
    },
  };
}
