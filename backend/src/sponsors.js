import { timingSafeEqual } from 'node:crypto';

// Sponsors que dan cupón. El nombre tiene que coincidir con el que figura en la web (alt de cada logo).
export const SPONSORS = [
  { id: 'la-genovesa', nombre: 'La Genovesa' },
  { id: 'pizza-hot', nombre: 'Pizza Hot' },
  { id: 'sushi-club', nombre: 'Sushi Club' },
  { id: 'pertutti', nombre: 'Pertutti' },
  { id: 'camoia', nombre: 'Camoia' },
  { id: 'broome', nombre: 'Broome' },
  { id: 'pannunzio-wines', nombre: 'Pannunzio Wines' },
];

// Desde cuántos números en una misma compra se entrega un cupón.
export const CUPON_DESDE = 3;

export const nombreSponsor = (id) => SPONSORS.find((s) => s.id === id)?.nombre ?? id;

/** CUPON_PINES="la-genovesa:4821,pizza-hot:7305,..." -> { 'la-genovesa': '4821', ... } */
export function leerPines(valor = process.env.CUPON_PINES) {
  const pines = {};
  for (const par of String(valor ?? '').split(',')) {
    const [id, pin] = par.split(':').map((x) => x?.trim());
    if (id && pin && SPONSORS.some((s) => s.id === id)) pines[id] = pin;
  }
  return pines;
}

export function pinCorrecto(pines, sponsor, pin) {
  const esperado = Buffer.from(String(pines?.[sponsor] ?? ''));
  const dado = Buffer.from(String(pin ?? '').trim());
  return esperado.length > 0 && esperado.length === dado.length && timingSafeEqual(esperado, dado);
}
