-- 0206_e3_recurring.sql
-- Entrega 3, bloque 6: ingresos y gastos recurrentes. Una migración aplicada es inmutable.
-- Una recurrencia es una EXPECTATIVA: sin confirmación no cambia ninguna cuenta (RN-RE02/RE03). Plantilla → ocurrencia → movimiento confirmado.

create table recurring_template (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid        not null references user_profile(id),
  name              text        not null check (length(btrim(name)) > 0),
  kind              text        not null check (kind in ('income','expense')),
  account_id        uuid        not null,
  amount            numeric(14,2) not null check (amount > 0),
  category_id       uuid,
  contact_id        uuid,
  description       text        not null default '',
  interval_unit     text        not null check (interval_unit in ('day','week','month','year')),
  interval_count    int         not null check (interval_count >= 1),
  anchor_date       date        not null,                 -- primera fecha y día de referencia (31 → 28 → 31)
  end_date          date,
  generated_through date        not null,                 -- hasta qué fecha ya se generaron ocurrencias
  status            text        not null default 'active' check (status in ('active','paused','archived')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           int         not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, account_id)  references account (owner_id, id),
  foreign key (owner_id, category_id) references category (owner_id, id),
  foreign key (owner_id, contact_id)  references contact (owner_id, id)
);
create trigger recurring_template_touch before update on recurring_template for each row execute function touch_row();

-- Ocurrencia esperada de una plantilla en una fecha. UNIQUE (plantilla, fecha) hace la generación idempotente (RN-RE03).
create table expected_occurrence (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  template_id   uuid        not null,
  due_date      date        not null,
  amount        numeric(14,2) not null check (amount > 0),   -- importe esperado al generarse
  status        text        not null default 'pending' check (status in ('pending','confirmed','skipped')),
  operation_id  uuid,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  unique (template_id, due_date),
  foreign key (owner_id, template_id)  references recurring_template (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id),
  check ((status = 'confirmed') = (operation_id is not null))
);
-- Un movimiento solo puede cumplir una ocurrencia: vincular uno existente no crea un segundo registro (RN-RE04).
create unique index expected_occurrence_op_uq on expected_occurrence (operation_id) where operation_id is not null;
create index expected_occurrence_pending_idx on expected_occurrence (owner_id, due_date) where status = 'pending';
