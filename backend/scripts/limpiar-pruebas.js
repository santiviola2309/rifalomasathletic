// Borra las compras de prueba y deja solo las que indiques. Se corre a mano en el servidor:
//   node scripts/limpiar-pruebas.js                          -> lista todas las compras
//   node scripts/limpiar-pruebas.js --conservar ORD-XXXX      -> simulacro: muestra qué se borraría
//   node scripts/limpiar-pruebas.js --conservar ORD-XXXX --confirmar   -> borra de verdad
import { makePool } from '../src/db.js';
import { limpiarPruebas, listarOrdenes } from '../src/limpieza.js';

const args = process.argv.slice(2);
const conservar = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--conservar') { while (args[i + 1] && !args[i + 1].startsWith('--')) conservar.push(...args[++i].split(',')); }
}
const confirmar = args.includes('--confirmar');
const pesos = (n) => '$' + Number(n ?? 0).toLocaleString('es-AR');
const fila = (o) => `${o.ref}  ${String(o.estado).padEnd(18)} ${pesos(o.monto).padStart(9)}  ${String(o.comprador).slice(0, 22).padEnd(22)}  ` +
  `${new Date(o.creada_en).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}  nums: ${o.numeros.join(' ') || '-'}  ` +
  `pagos: ${o.pagos.map((p) => `${p.id}(${p.estado_mp}/${p.resultado})`).join(' ') || '-'}`;

const pool = makePool();
try {
  if (!conservar.length) {
    const todas = await listarOrdenes(pool);
    console.log(`Hay ${todas.length} compras en la base:\n`);
    todas.forEach((o) => console.log(fila(o)));
    console.log('\nBuscá la compra real y volvé a correr con:  node scripts/limpiar-pruebas.js --conservar ORD-XXXX');
  } else {
    const r = await limpiarPruebas(pool, { conservar, confirmar });
    console.log('SE CONSERVA:');   r.conservadas.forEach((o) => console.log('  ' + fila(o)));
    console.log(`\n${r.confirmado ? 'SE BORRÓ' : 'SE BORRARÍA'} (${r.aBorrar.length} compras):`);
    r.aBorrar.forEach((o) => console.log('  ' + fila(o)));
    if (r.protegidas.length) { console.log(`\nNO se tocan (pendientes de hace menos de 20 min, podrían estar pagando ahora): ${r.protegidas.length}`); r.protegidas.forEach((o) => console.log('  ' + fila(o))); }
    if (r.pagosSinOrden) console.log(`\nAviso: hay ${r.pagosSinOrden} pagos sin compra asociada. No se borran; revisalos en Mercado Pago.`);
    if (!r.confirmado) console.log('\nEs un SIMULACRO: no se borró nada. Si la lista es correcta, repetí el comando agregando --confirmar');
    else console.log('\nListo. Los números de las compras borradas volvieron a quedar libres.');
  }
} catch (e) {
  console.error('ERROR:', e.message); process.exitCode = 1;
} finally { await pool.end(); }
