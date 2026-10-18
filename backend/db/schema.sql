-- Esquema de la rifa. Idempotente: se puede correr más de una vez.
-- Reglas de integridad que sostiene la base (no el código de la web):
--   * cada número (0001-1700) es una fila única: no se puede vender dos veces
--   * un pago de Mercado Pago se guarda una sola vez (mp_payment_id es clave)
--   * una orden tiene como máximo un pago "asignado" (índice parcial)

create table if not exists jugadores (
  codigo    text primary key check (codigo = upper(codigo)),
  nombre    text not null,
  categoria text not null
);

create table if not exists ordenes (
  id                 uuid primary key,
  ref                text not null unique,            -- external_reference que viaja a Mercado Pago
  comprador_nombre   text not null,
  comprador_whatsapp text not null,
  cantidad           int  not null check (cantidad between 1 and 20),
  modo               text not null check (modo in ('azar', 'elegir')),
  numeros_elegidos   smallint[],
  jugador_codigo     text references jugadores (codigo),
  monto              int  not null check (monto > 0), -- en pesos
  estado             text not null default 'pendiente'
                     check (estado in ('pendiente', 'pagada', 'vencida', 'requiere_reembolso')),
  expira_en          timestamptz not null,
  mp_preference_id   text,
  creada_en          timestamptz not null default now(),
  check ((modo = 'elegir') = (numeros_elegidos is not null and cardinality(numeros_elegidos) = cantidad))
);

-- Vendedor: el comprador escribe el nombre completo del jugador y elige su categoría.
-- (jugador_codigo queda solo por compatibilidad con ventas de pruebas anteriores)
alter table ordenes add column if not exists vendedor_nombre text;
alter table ordenes add column if not exists vendedor_categoria text;
alter table ordenes add column if not exists vendedor_clave text;   -- nombre sin tildes ni mayúsculas

create table if not exists numeros (
  numero          smallint primary key check (numero between 1 and 1700),
  estado          text not null default 'libre' check (estado in ('libre', 'reservado', 'vendido')),
  orden_id        uuid references ordenes (id),
  reservado_hasta timestamptz,
  check ((estado = 'libre') = (orden_id is null))
);

insert into numeros (numero)
select g from generate_series(1, 1700) g
on conflict do nothing;

create table if not exists pagos (
  mp_payment_id      text primary key,
  orden_id           uuid references ordenes (id),
  external_reference text,
  estado_mp          text not null,
  monto              int,
  resultado          text not null default 'pendiente'
                     check (resultado in ('pendiente', 'asignado', 'requiere_reembolso',
                                          'sin_orden', 'monto_distinto', 'no_aprobado')),
  detalle            text,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);

create unique index if not exists un_pago_asignado_por_orden
  on pagos (orden_id) where resultado = 'asignado';

create table if not exists notificaciones (
  id        bigserial primary key,
  orden_id  uuid references ordenes (id),
  tipo      text not null,
  payload   jsonb not null,
  creada_en timestamptz not null default now()
);
