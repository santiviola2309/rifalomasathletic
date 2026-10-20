// Genera un PIN de 4 dígitos por sponsor para canjear cupones.
//   node scripts/generar-pines.js
// Imprime la línea para la variable CUPON_PINES (se carga en Render) y la lista para pasarle a cada comercio.
import { randomInt } from 'node:crypto';
import { SPONSORS } from '../src/sponsors.js';

const usados = new Set();
const pines = SPONSORS.map((s) => {
  let pin; do { pin = String(randomInt(1000, 10000)); } while (usados.has(pin));
  usados.add(pin); return { ...s, pin };
});
console.log('1) En Render, Environment, agregá esta variable (se guarda UNA sola vez):\n');
console.log('CUPON_PINES=' + pines.map((p) => `${p.id}:${p.pin}`).join(',') + '\n');
console.log('2) Pasale a cada comercio SOLO su PIN, por privado:\n');
pines.forEach((p) => console.log(`   ${p.nombre.padEnd(18)} ${p.pin}`));
console.log('\nLos comercios canjean en  https://rifalomasathletic.onrender.com/#canje  con el código del cupón y su PIN.');
