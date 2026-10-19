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
                     check (estado in ('pendiente', 'pagada', 'vencida', 'requiere_reembolso', 'cancelada')),
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

-- Aviso a compradores (panel de organizadores): quién ya recibió sus números por WhatsApp.
--   pagada_en    : cuándo se acreditó el pago (para ordenar y mostrar "hace X min")
--   avisado_en   : cuándo un organizador avisó al comprador (null = pendiente de aviso)
--   wsp_tocado_en: cuándo el propio comprador tocó su botón "Enviarme mis números por WhatsApp"
alter table ordenes add column if not exists pagada_en timestamptz;
alter table ordenes add column if not exists avisado_en timestamptz;
alter table ordenes add column if not exists wsp_tocado_en timestamptz;

-- Cancelar compras desde el panel. Una compra cancelada libera sus números (se guardan en
-- numeros_anulados como registro) y nunca vuelve a recibirlos aunque llegue un pago atrasado.
alter table ordenes add column if not exists cancelada_en timestamptz;
alter table ordenes add column if not exists numeros_anulados smallint[];
do $$
declare c record;
begin
  -- Bases creadas antes: la regla de estados no incluía 'cancelada'.
  for c in select conname from pg_constraint
           where conrelid = 'ordenes'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%requiere_reembolso%'
             and pg_get_constraintdef(oid) not like '%cancelada%'
  loop
    execute format('alter table ordenes drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'ordenes'::regclass and contype = 'c'
                 and pg_get_constraintdef(oid) like '%cancelada%') then
    alter table ordenes add constraint ordenes_estado_valido
      check (estado in ('pendiente', 'pagada', 'vencida', 'requiere_reembolso', 'cancelada'));
  end if;
end $$;

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
