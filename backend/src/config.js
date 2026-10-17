import { crearMpSimulado } from './mp.js';
import { crearMpReal, esTokenDePrueba, normalizarToken } from './mp-real.js';

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

  const token = normalizarToken(env.MP_ACCESS_TOKEN);
  if (!token) throw new Error(`MP_MODO=${modo} requiere MP_ACCESS_TOKEN`);

  if (modo === 'prueba') {
    const mp = crearMpReal({ accessToken: token, baseUrl, usarSandbox: env.MP_SANDBOX === '1' });
    // Con prefijo TEST- alcanza. Si no lo tiene (Mercado Pago también entrega credenciales de
    // prueba con otro formato), el servidor verifica con exigirCuentaDePrueba() antes de arrancar.
    return { modo, baseUrl, mp, verificarCuenta: !esTokenDePrueba(token), inicioToken: token.slice(0, 4) };
  }

  // produccion
  if (esTokenDePrueba(token)) throw new Error('MP_MODO=produccion pero el token es de prueba (TEST-…).');
  const faltan = [];
  if (!baseUrl.startsWith('https://')) faltan.push('BASE_URL con https://');
  for (const v of ['PANEL_KEY', 'MP_WEBHOOK_SECRET', 'RIFA_AUTORIZACION_NRO']) if (!env[v]) faltan.push(v);
  if (faltan.length) throw new Error(`MP_MODO=produccion requiere: ${faltan.join(', ')}`);
  return { modo, baseUrl, mp: crearMpReal({ accessToken: token, baseUrl }) };
}

/**
 * Se niega a seguir si la credencial no es de una cuenta de PRUEBA de Mercado Pago
 * (usuario TESTUSER…). Evita cobrar de verdad con la cuenta real por error.
 */
export async function exigirCuentaDePrueba(mp, inicioToken = '') {
  let cuenta;
  try {
    cuenta = await mp.getAccount();
  } catch (e) {
    throw new Error(`MP_MODO=prueba: no se pudo verificar con Mercado Pago que la credencial sea de una `
      + `cuenta de prueba (${e.message}). No se arranca para no cobrar de verdad.`);
  }
  if (!/^TEST/i.test(cuenta.nickname)) {
    throw new Error('MP_MODO=prueba: la credencial pertenece a una cuenta REAL '
      + `(usuario "${cuenta.nickname.slice(0, 4)}…"), no a una cuenta de prueba (TESTUSER…). `
      + `El valor cargado empieza con "${inicioToken}…". No se arranca para no cobrar de verdad.`);
  }
}
