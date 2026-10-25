-- 0402_e5_backups.sql
-- Entrega 5, bloque 3: respaldos recuperables (09 §6, RN-BK01…BK10). Una migración aplicada es inmutable.
-- El contenido del respaldo vive en el almacenamiento privado (archivo comprimido y, si hay clave, cifrado); aquí solo su registro.

create table backup (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid        not null references user_profile(id),
  kind           text        not null check (kind in ('manual','auto','recovery','imported')),
  format_version int         not null,
  schema_version text        not null,                  -- última migración aplicada al generarlo (RN-BK09)
  file_key       text        not null,
  size_bytes     int         not null check (size_bytes >= 0),
  data_hash      text        not null,                  -- sha-256 del contenido: integridad (RN-BK05)
  encrypted      boolean     not null default false,
  manifest       jsonb       not null,                  -- filas por tabla, saldos por cuenta, fechas
  note           text,
  created_at     timestamptz not null default now(),
  unique (owner_id, id)
);
create index backup_owner_idx on backup (owner_id, kind, created_at desc);
