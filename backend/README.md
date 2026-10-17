# Backend de la rifa

Tres modos, elegidos con `MP_MODO` (ver `.env.example` y `src/config.js`):

| Modo | Qué hace |
|---|---|
| `simulado` (por defecto) | Sin conexión a Mercado Pago. Checkout falso en `/mock-mp/…`. |
| `prueba` | Mercado Pago **real** con credenciales `TEST-…`. No mueve plata. |
| `produccion` | Cobros reales. Solo arranca con token de producción, HTTPS, `PANEL_KEY`, `MP_WEBHOOK_SECRET` y `RIFA_AUTORIZACION_NRO`. |

El servidor **se niega a arrancar** si las credenciales no corresponden al modo (por
ejemplo, un token de producción con `MP_MODO=prueba`), para no cobrar de verdad por error.

**A dónde llega la plata:** a la cuenta de Mercado Pago dueña del `MP_ACCESS_TOKEN` con el
que se crea el link de pago. El token lo carga el titular de la cuenta como variable del
servidor; nunca va en el repo, en el chat ni en logs.

## Correr

```bash
cd backend
npm install
export DATABASE_URL=postgres://usuario@host:5432/rifa   # una base Postgres vacía
npm run db:schema      # crea las tablas (idempotente)
PANEL_KEY=una-clave MP_WEBHOOK_SECRET=otro-secreto npm start
```

Pruebas (usan `TEST_DATABASE_URL`, por defecto `postgres://postgres@127.0.0.1:54329/rifa_test`;
**borran los datos de esa base**):

```bash
npm test
```

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/crear-pago` | Crea la orden, reserva números 10 min, devuelve el link de pago |
| POST | `/api/mp-webhook` | Aviso de pago de MP: verifica firma, consulta el pago, asigna números |
| GET | `/api/orden/:ref` | Estado de la orden y, si está pagada, sus números |
| GET | `/api/panel` | Ventas por vendedor y categoría (header `x-panel-key`) |
| GET | `/api/conciliacion` | Cruce órdenes / pagos / números (header `x-panel-key`) |
| GET/POST | `/mock-mp/:ref` | Checkout simulado (solo modo prueba) |

`POST /api/crear-pago` recibe: `nombre`, `whatsapp`, `cantidad` (1-20), `modo` (`azar` o
`elegir`), `numeros` (si elige) y `codigoVendedor` (opcional).

## Garantías (y la prueba que las cubre)

- Un pago de MP se registra **una sola vez** y asigna números una sola vez, aunque el aviso
  llegue 50 veces a la vez (`pagos.test.js`).
- El pago se asocia a su orden **solo** por `external_reference`, nunca por nombre, monto ni
  orden de llegada. Pepito Gamer paga y la orden de Pepito Mamó queda pendiente.
- Una orden acepta **un solo** pago asignado. Un segundo pago queda `requiere_reembolso`.
- Monto distinto, referencia desconocida o pago sin aprobar: no asignan números.
- Un número no se vende dos veces, ni bajo 100 pedidos simultáneos. Se venden los 1700 en
  paralelo sin duplicados ni sobreventa (`concurrencia.test.js`).
- Reserva vencida: si el número sigue libre, el pago tardío lo asigna; si lo tomó otro, va a
  reembolso. Nunca se vende un número 1701.
- Los avisos se verifican por firma (`x-signature`) y el pago se vuelve a consultar a la API
  de MP; no se confía en el cuerpo del aviso.

## Lo que falta antes de cobrar de verdad

1. Probar el adaptador real (`src/mp-real.js`) con credenciales `TEST-…` de la cuenta titular
   y comprobar los campos contra la documentación vigente de Mercado Pago (hoy está probado
   solo contra un `fetch` falso). Configurar el webhook en el panel de la app apuntando a
   `/api/mp-webhook`, con el secreto en `MP_WEBHOOK_SECRET`.
2. Confirmar el formato de la firma del webhook y las reglas de Mercado Pago para rifas.
3. Habilitación de la rifa y cuenta titular definidas.
4. Envío real del comprobante por WhatsApp o mail (hoy queda en la tabla `notificaciones`).
5. Manejo de devoluciones y contracargos posteriores a la asignación (hoy solo se marca el
   cambio de estado en `pagos.detalle` y aparece en `/api/conciliacion`).
6. Cargar el padrón real de jugadores (tabla `jugadores`) con sus códigos. Los de prueba son
   de ejemplo.
7. Despliegue (Postgres administrado + hosting con HTTPS) y revisión de seguridad.
