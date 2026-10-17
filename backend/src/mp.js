import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Interfaz que usa el resto del backend:
 *   createPreference({ ref, monto, titulo }) -> { id, init_point }
 *   getPayment(id)                           -> { id, status, amount, external_reference }
 *
 * Hoy solo existe la versión SIMULADA. No hay conexión con Mercado Pago ni
 * ninguna credencial. El adaptador real se escribe contra esta misma interfaz.
 */
export function crearMpSimulado({ baseUrl = 'http://localhost:3000' } = {}) {
  const preferencias = new Map();
  const pagos = new Map();
  let seq = 1000;

  return {
    async createPreference({ ref, monto, titulo }) {
      const id = `PREF-${ref}`;
      preferencias.set(id, { ref, monto, titulo });
      return { id, init_point: `${baseUrl}/mock-mp/${ref}` };
    },
    async getPayment(id) {
      const p = pagos.get(String(id));
      if (!p) throw new Error(`Pago inexistente en MP: ${id}`);
      return { ...p };
    },

    // --- ayudas de prueba (no existen en Mercado Pago real) ---
    preferencia: (ref) => preferencias.get(`PREF-${ref}`),
    simularPago({ ref, amount, status = 'approved', id }) {
      const pid = String(id ?? ++seq);
      pagos.set(pid, { id: pid, status, amount, external_reference: ref });
      return pid;
    },
    cambiarEstado(pid, status) {
      const p = pagos.get(String(pid));
      pagos.set(String(pid), { ...p, status });
    },
  };
}

/**
 * Verifica la firma del aviso: cabecera x-signature = "ts=...,v1=<hmac>".
 * El mensaje firmado es `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`.
 * Formato según la documentación de Mercado Pago al momento de escribir esto:
 * confirmarlo contra la documentación vigente antes de pasar a producción.
 */
export function verificarFirma({ secreto, firma, requestId, dataId }) {
  if (!secreto) return false;
  const partes = Object.fromEntries(
    String(firma ?? '').split(',').map((kv) => kv.trim().split('=')).filter((kv) => kv.length === 2),
  );
  if (!partes.ts || !partes.v1) return false;
  const manifiesto = `id:${String(dataId).toLowerCase()};request-id:${requestId ?? ''};ts:${partes.ts};`;
  const esperado = createHmac('sha256', secreto).update(manifiesto).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(partes.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function firmar({ secreto, requestId, dataId, ts = String(Date.now()) }) {
  const manifiesto = `id:${String(dataId).toLowerCase()};request-id:${requestId ?? ''};ts:${ts};`;
  return `ts=${ts},v1=${createHmac('sha256', secreto).update(manifiesto).digest('hex')}`;
}
