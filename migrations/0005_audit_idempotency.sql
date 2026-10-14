-- 0005_audit_idempotency.sql
-- Auditoría e idempotencia. Generado desde docs/especificacion/12-modelo-de-datos.md §6.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

create table audit_event (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid        not null references user_profile(id),
  actor_id     uuid        not null,
  action       text        not null,                     -- 'receipt.create', 'allocation.release', …
  entity_type  text        not null,
  entity_id    uuid        not null,
  reason       text,
  changes      jsonb,                                    -- solo campos pertinentes; sin secretos ni correos
  at           timestamptz not null default now()
);
create index audit_entity_idx on audit_event (owner_id, entity_type, entity_id);
create index audit_at_idx     on audit_event (owner_id, at desc);
create trigger audit_event_immutable before update or delete on audit_event
  for each row execute function forbid_mutation();

-- Un reintento con la misma clave devuelve el resultado ya guardado
create table idempotency_record (
  owner_id         uuid        not null references user_profile(id),
  key              text        not null check (length(key) between 8 and 128),
  endpoint         text        not null,
  request_hash     text        not null,
  response_status  int         not null,
  response_body    jsonb       not null,
  created_at       timestamptz not null default now(),
  primary key (owner_id, key)
);
-- Se purgan registros con más de 7 días (tarea periódica).
