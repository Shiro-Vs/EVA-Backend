-- 0301_e4_capture.sql
-- Entrega 4, bloque 1: captura asistida. La captura PROPONE; el usuario CONFIRMA (07). Una migración aplicada es inmutable.
-- Documento fuente → ejecución de extracción → propuestas de movimiento → (aceptar | vincular | descartar).

-- Dirección de recepción: una activa por usuario; rotar la revoca y crea otra (07 §3).
create table inbox_address (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  address     text        not null,
  status      text        not null default 'active' check (status in ('active','revoked')),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create unique index inbox_address_unique on inbox_address (lower(address));
create unique index inbox_address_one_active on inbox_address (owner_id) where status = 'active';

-- Lo que llegó: correo, foto, PDF o texto pegado. La reentrega exacta se deduplica por hash o por id de mensaje (RN-DU01).
create table source_document (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  origin        text        not null check (origin in ('email','photo','pdf','text')),
  content_hash  text        not null,
  message_id    text,
  sender        text,
  subject       text,
  mime          text        not null,
  filename      text,
  size_bytes    int         not null check (size_bytes >= 0),
  file_key      text,                                   -- clave en el almacenamiento privado; null si ya se eliminó por retención
  body_text     text,                                   -- cuerpo del correo o texto pegado (dato no confiable)
  received_at   timestamptz not null default now(),
  status        text        not null default 'received' check (status in ('received','proposed','failed','discarded','no_transaction')),
  error_code    text,
  error_detail  text,
  attempts      int         not null default 0,
  file_deleted_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       int         not null default 1,
  unique (owner_id, id),
  unique (owner_id, content_hash)
);
create unique index source_document_message_uq on source_document (owner_id, message_id) where message_id is not null;
create index source_document_status_idx on source_document (owner_id, status, received_at desc);
create trigger source_document_touch before update on source_document for each row execute function touch_row();

-- Cada intento de extracción, con su costo (07 §6.7). `raw` guarda lo devuelto por el modelo ya validado o el motivo del rechazo.
create table extraction_run (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  document_id   uuid        not null,
  status        text        not null check (status in ('ok','failed')),
  provider      text        not null,
  model         text        not null,
  tokens_in     int         not null default 0,
  tokens_out    int         not null default 0,
  cost_estimate numeric(12,6) not null default 0,
  error_code    text,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  foreign key (owner_id, document_id) references source_document (owner_id, id)
);
create index extraction_run_doc_idx on extraction_run (document_id, created_at);

-- Consumo de IA por tarea, para el tope diario/mensual (D-27). Las tareas de captura y de análisis comparten el contador.
create table usage_record (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  kind          text        not null check (kind in ('extraction','analysis')),
  provider      text        not null,
  model         text        not null,
  tokens_in     int         not null default 0,
  tokens_out    int         not null default 0,
  retries       int         not null default 0,
  cost_estimate numeric(12,6) not null default 0,
  local_day     date        not null,
  created_at    timestamptz not null default now()
);
create index usage_record_day_idx on usage_record (owner_id, local_day);

-- Propuesta de movimiento (RN-CA01). No toca saldos hasta aceptarse.
create table movement_proposal (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid        not null references user_profile(id),
  document_id     uuid        not null,
  status          text        not null default 'pending' check (status in ('pending','accepted','linked','discarded')),
  direction       text        not null check (direction in ('income','expense','transfer')),
  amount          numeric(14,2) check (amount is null or amount > 0),
  currency        char(3)     not null default 'PEN',
  occurred_on     date,
  counterparty    text,
  channel         text,
  operation_ref   text,                                  -- identificador de operación que consta en el documento
  concept         text,
  suggested_category text,
  items           jsonb       not null default '[]',
  account_id      uuid,
  to_account_id   uuid,
  category_id     uuid,
  contact_id      uuid,
  description     text,
  missing         jsonb       not null default '[]',
  warnings        jsonb       not null default '[]',
  confidence      numeric(4,3),
  operation_id    uuid,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         int         not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, document_id)    references source_document (owner_id, id),
  foreign key (owner_id, account_id)     references account (owner_id, id),
  foreign key (owner_id, to_account_id)  references account (owner_id, id),
  foreign key (owner_id, category_id)    references category (owner_id, id),
  foreign key (owner_id, contact_id)     references contact (owner_id, id),
  foreign key (owner_id, operation_id)   references financial_operation (owner_id, id),
  check ((status in ('accepted','linked')) = (operation_id is not null))
);
create index movement_proposal_status_idx on movement_proposal (owner_id, status, created_at desc);
create index movement_proposal_doc_idx on movement_proposal (document_id);
create trigger movement_proposal_touch before update on movement_proposal for each row execute function touch_row();

-- Posible coincidencia (RN-DU02): la propuesta se parece a otra propuesta o a un movimiento ya registrado.
create table duplicate_candidate (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid        not null references user_profile(id),
  proposal_id        uuid        not null,
  other_proposal_id  uuid,
  operation_id       uuid,
  reason             text        not null check (reason in ('operation_ref','amount_account_window')),
  created_at         timestamptz not null default now(),
  foreign key (owner_id, proposal_id)       references movement_proposal (owner_id, id),
  foreign key (owner_id, other_proposal_id) references movement_proposal (owner_id, id),
  foreign key (owner_id, operation_id)      references financial_operation (owner_id, id),
  check ((other_proposal_id is not null) <> (operation_id is not null))
);
create index duplicate_candidate_proposal_idx on duplicate_candidate (proposal_id);

-- Evidencia: el documento queda vinculado al movimiento final (RN-DU04).
create table evidence_link (
  owner_id      uuid        not null references user_profile(id),
  document_id   uuid        not null,
  operation_id  uuid        not null,
  created_at    timestamptz not null default now(),
  primary key (document_id, operation_id),
  foreign key (owner_id, document_id)  references source_document (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id)
);

-- Reglas por remitente: completan cuenta, categoría y contacto de las propuestas (07 §5). Las reglas del usuario van antes que la IA.
create table sender_rule (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid        not null references user_profile(id),
  sender       text        not null check (length(btrim(sender)) > 0),   -- correo o fragmento, sin distinguir mayúsculas
  account_id   uuid,
  category_id  uuid,
  contact_id   uuid,
  status       text        not null default 'active' check (status in ('active','archived')),
  created_at   timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, account_id)  references account (owner_id, id),
  foreign key (owner_id, category_id) references category (owner_id, id),
  foreign key (owner_id, contact_id)  references contact (owner_id, id)
);
create unique index sender_rule_unique on sender_rule (owner_id, lower(sender)) where status = 'active';
