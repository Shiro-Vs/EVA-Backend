-- 0401_e5_reports.sql
-- Entrega 5, bloque 1: resumen mensual con versiones guardadas (RN-RM01…RM04). Una migración aplicada es inmutable.
-- Una versión guardada es una INSTANTÁNEA de números, no un enlace: lo que se corrija después genera otra versión y la anterior no se borra.

create table report_snapshot (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid        not null references user_profile(id),
  kind           text        not null check (kind in ('monthly')),
  period         text        not null,                     -- 'YYYY-MM'
  params         jsonb       not null,                     -- cuentas y nivel de detalle
  params_hash    text        not null,
  version        int         not null check (version >= 1),
  rules_version  text        not null,                     -- versión de las reglas de cálculo (RN-RM03)
  data_hash      text        not null,
  data           jsonb       not null,
  generated_at   timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, kind, period, params_hash, version)
);
create index report_snapshot_period_idx on report_snapshot (owner_id, kind, period, generated_at desc);

-- Inmutable: ni se edita ni se borra (RN-RM02).
create function report_snapshot_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'REPORT_SNAPSHOT_IMMUTABLE' using errcode = 'check_violation';
end $$;
create trigger report_snapshot_no_change before update or delete on report_snapshot for each row execute function report_snapshot_immutable();
