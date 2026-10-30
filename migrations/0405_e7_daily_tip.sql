-- 0405_e7_daily_tip.sql
-- Consejo del día con IA: uno por usuario y por día local, generado a partir de los datos que ya calculó el servidor.
-- Una migración aplicada es inmutable.

alter table usage_record drop constraint usage_record_kind_check;
alter table usage_record add constraint usage_record_kind_check check (kind in ('extraction','analysis','tip'));

create table daily_tip (
  owner_id    uuid        not null references user_profile(id),
  local_day   date        not null,
  focus       text        not null,
  body        text        not null,
  provider    text        not null,
  model       text        not null,
  created_at  timestamptz not null default now(),
  primary key (owner_id, local_day)
);
