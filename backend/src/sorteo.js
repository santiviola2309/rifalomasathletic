// Sorteo extra de premios de los sponsors: cada compra suma una chance cada SORTEO_CADA números.
export const SORTEO_CADA = 3;
export const chancesDe = (cantidad) => Math.floor(Number(cantidad) / SORTEO_CADA);

/**
 * Premios que se muestran en la web, desde la variable PREMIOS_SORTEO_EXTRA:
 * "La Genovesa: Vale de $50.000; Pizza Hot: 2 pizzas grandes". Se separan con ; o con saltos de línea.
 */
export function leerPremios(texto) {
  return String(texto ?? '').split(/[;\n]/).map((t) => t.trim()).filter(Boolean).slice(0, 30).map((t) => {
    const i = t.indexOf(':');
    const sponsor = i > 0 ? t.slice(0, i).trim() : '';
    const premio = (i > 0 ? t.slice(i + 1) : t).trim();
    return { sponsor: sponsor.slice(0, 60), premio: premio.slice(0, 120) };
  }).filter((p) => p.premio);
}
