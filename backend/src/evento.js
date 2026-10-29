// Datos del evento y precios. Es la única fuente: la web los recibe del servidor, no los repite.
export const EVENTO = {
  nombre: 'Bingo Familiar',                    // se ve en la barra superior y el pie
  titulo: 'Una noche de bingo a beneficio',    // título grande de la portada
  institucion: 'Colegio Balmoral',
  cuando: 'Viernes, 30 de octubre, 18:00 hs',
  donde: 'Manuel Castro 1536',
  lema: 'Labor omnia vincit',
};

// Premios que se muestran en la web, del mejor al menos valioso. Si en Render se carga la variable PREMIOS, esa lista manda.
export const PREMIOS_EVENTO = [
  'Estadía de 1 noche en el Faena para 2 personas',
  'AirPods',
  'Par de botines',
  'Par de zapatillas Jaguar',
  'Cena para 2 en restaurante El Secreto',
  '6 bolsas de ropa Tuboos',
  'Set de perfumes',
  'Perfume importado de mujer',
  'Espejo Asuni Señor',
  'Malla Billabong',
  '2 entradas para «La cena de los tontos» con Martín Bossi (Teatro Morón)',
  'Gift card para almuerzo en Blossom',
  'Gift card para almuerzo en Blossom',
  'Tarjeta de regalo de $50.000 en Del Pilar Home',
  'Orden de compra de $50.000 en Red & Blue',
  '2 cajas de productos para el pelo Estereocolor',
  '3 cajas de vino',
  'Box de regalo de Contagiamor (vouchers con descuento, con compra mínima)',
  'Tabla de 40 piezas de sushi',
  'Olla Hudson de cocina, nueva',
  'Mochila FW',
  'Batidora eléctrica de mano',
  'Anafe portátil',
  'Tostadora Frávega',
  '2 vouchers de Olika',
  '2 vouchers para meriendas para compartir, con descuento, en Mona',
  'Set de mate',
  'Botella de gin tonic',
  'Voucher Melillanka',
  'Taller de automaquillaje',
  'Set de lavado y limpieza de auto',
  'Prendas de la Fe',
  'Set de póker',
  'Gift card de belleza de manos en Gervasa',
  'Box de snacks saludables',
  '2 box de Central Cookies',
  'Gift card de la Heladería del Paseo',
  'Corte de pelo en peluquería masculina Agustín Acosta',
  '3 cookies rellenas de Paquita',
  'Cupón de 20% de descuento en Casa Mia',
];

export const PRECIO_ENTRADA = 5000;      // entrada anticipada, incluye 1 cartón
export const PRECIO_CARTON = 2000;       // cartón suelto, sin entrada
export const TOTAL_CARTONES = 500;       // cartones numerados del 1 al TOTAL_CARTONES
export const MAX_CARTONES_POR_COMPRA = 20;

/** Premios que se muestran en la web, desde la variable PREMIOS: "Premio uno; Premio dos". Se separan con ; o saltos de línea. */
export function leerPremios(texto) {
  return String(texto ?? '').split(/[;\n]/).map((t) => t.trim().slice(0, 300)).filter(Boolean).slice(0, 40);
}
