-- 0303_e4_analysis.sql
-- Entrega 4, bloque 2: análisis y chat con IA (07 §9). Una migración aplicada es inmutable.
-- La IA solo explica datos que calcula el servidor dentro del alcance que elige el usuario; nunca modifica nada.
-- Guardar un análisis es opcional; el historial del chat es opt-in y se puede borrar (se elimina, no se archiva).

create table analysis_request (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  scope       jsonb       not null,             -- periodo y filtros elegidos (cuentas, categorías, servicios)
  question    text        not null,
  created_at  timestamptz not null default now(),
  unique (owner_id, id)
);

create table analysis_result (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid        not null references user_profile(id),
  request_id   uuid        not null unique,
  answer       text        not null,
  coverage     jsonb       not null,            -- datos faltantes, movimientos sin categoría, periodo cubierto
  provider     text        not null,
  model        text        not null,
  created_at   timestamptz not null default now(),
  foreign key (owner_id, request_id) references analysis_request (owner_id, id) on delete cascade
);

create table chat_session (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  title         text        not null default '',
  scope         jsonb       not null,
  save_history  boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id, id)
);
create index chat_session_owner_idx on chat_session (owner_id, updated_at desc);

create table chat_message (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  session_id  uuid        not null,
  role        text        not null check (role in ('user','assistant')),
  content     text        not null,
  created_at  timestamptz not null default now(),
  foreign key (owner_id, session_id) references chat_session (owner_id, id) on delete cascade
);
create index chat_message_session_idx on chat_message (session_id, created_at, id);
