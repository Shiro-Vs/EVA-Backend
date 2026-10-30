-- 0403_e6_exports.sql
-- Entrega 6: exportaciones (08 §5, §6). Una migración aplicada es inmutable.
-- Cada exportación deja un registro con lo pedido (qué, periodo, formato) y su archivo temporal. Las grandes se generan en segundo plano;
-- el archivo vence (24 h por defecto) y se borra. Exportar NO reemplaza el respaldo recuperable (09 §6).

create table export_job (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  params        jsonb       not null,                  -- periodo, cuentas, secciones en orden, nivel y formato
  format        text        not null check (format in ('csv','xlsx','pdf')),
  status        text        not null default 'queued' check (status in ('queued','running','done','failed','expired')),
  rows          int         not null default 0,
  filename      text,
  mime          text,
  file_key      text,
  size_bytes    int,
  error_code    text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  expires_at    timestamptz,
  unique (owner_id, id)
);
create index export_job_owner_idx on export_job (owner_id, created_at desc);
