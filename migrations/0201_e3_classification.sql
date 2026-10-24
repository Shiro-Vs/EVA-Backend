-- 0201_e3_classification.sql
-- Entrega 3, bloque 1: reglas de clasificación y su rastro. Una migración aplicada es inmutable.

-- Reglas del usuario (RN-CL04/CL05/CL06). Condiciones opcionales (al menos una la exige la aplicación); gana la de menor prioridad.
create table classification_rule (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  name          text        not null check (length(btrim(name)) > 0),
  priority      int         not null default 100 check (priority >= 0),
  status        text        not null default 'active' check (status in ('active','archived')),
  account_id    uuid,
  direction     text        check (direction in ('income','expense')),
  amount_min    numeric(14,2) check (amount_min >= 0),
  amount_max    numeric(14,2) check (amount_max >= 0),
  text_contains text        check (text_contains is null or length(btrim(text_contains)) > 0),
  action        text        not null check (action in ('assign','suggest')),
  category_id   uuid        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       int         not null default 1,
  unique (owner_id, id),
  check (amount_min is null or amount_max is null or amount_min <= amount_max),
  foreign key (owner_id, account_id)  references account (owner_id, id),
  foreign key (owner_id, category_id) references category (owner_id, id)
);
create index classification_rule_owner_idx on classification_rule (owner_id, status, priority, created_at);
create trigger classification_rule_touch before update on classification_rule for each row execute function touch_row();

-- Qué regla (o qué persona) clasificó cada operación: «se muestra qué regla se aplicó» (RN-CL06). La evidencia no se borra.
create table classification_decision (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  operation_id  uuid        not null,
  rule_id       uuid,
  category_id   uuid        not null,
  mode          text        not null check (mode in ('assign','suggest','bulk','manual')),
  created_at    timestamptz not null default now(),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id),
  foreign key (owner_id, rule_id)      references classification_rule (owner_id, id),
  foreign key (owner_id, category_id)  references category (owner_id, id)
);
create index classification_decision_op_idx on classification_decision (operation_id, created_at desc);
