import { crearMpSimulado } from './mp.js';
import { crearMpReal, esTokenDePrueba } from './mp-real.js';

/**
 * Elige el adaptador de Mercado Pago según MP_MODO y se niega a arrancar si las
 * credenciales no corresponden al modo. Así no se cobra de verdad por error.
 *
 *   simulado   (por defecto)  sin conexión a Mercado Pago, checkout falso
 *   prueba                    Mercado Pago real con credenciales TEST-… (no mueve plata)
 *   produccion                cobros reales; exige HTTPS, clave de panel, secreto de webhook
 *                             y el número de autorización de la rifa
 */
export function elegirMp(env = process.env) {
  const modo = env.MP_MODO || 'simulado';
  const baseUrl = env.BASE_URL || `http://localhost:${env.PORT ?? 3000}`;

  if (modo === 'simulado') {
    return { modo, baseUrl, mp: crearMpSimulado({ baseUrl }) };
  }
  if (modo !== 'prueba' && modo !== 'produccion') {
    throw new Error(`MP_MODO inválido: "${modo}" (simulado, prueba o produccion)`);
  }

  const token = env.MP_ACCESS_TOKEN;
  if (!token) throw new Error(`MP_MODO=${modo} requiere MP_ACCESS_TOKEN`);

  if (modo === 'prueba') {
    if (!esTokenDePrueba(token)) {
      throw new Error('MP_MODO=prueba exige un Access Token de PRUEBA (empieza con TEST-). '
        + 'Es una credencial de producción: no se arranca para no cobrar de verdad.');
    }
    return { modo, baseUrl, mp: crearMpReal({ accessToken: token, baseUrl, usarSandbox: env.MP_SANDBOX === '1' }) };
  }

  // produccion
  if (esTokenDePrueba(token)) throw new Error('MP_MODO=produccion pero el token es de prueba (TEST-…).');
  const faltan = [];
  if (!baseUrl.startsWith('https://')) faltan.push('BASE_URL con https://');
  for (const v of ['PANEL_KEY', 'MP_WEBHOOK_SECRET', 'RIFA_AUTORIZACION_NRO']) if (!env[v]) faltan.push(v);
  if (faltan.length) throw new Error(`MP_MODO=produccion requiere: ${faltan.join(', ')}`);
  return { modo, baseUrl, mp: crearMpReal({ accessToken: token, baseUrl }) };
}
