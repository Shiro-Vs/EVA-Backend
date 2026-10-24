-- 0204_e3_budgets.sql
-- Entrega 3, bloque 4: presupuestos. Una migración aplicada es inmutable.
-- Un presupuesto es un LÍMITE de consumo, no dinero ni reserva bancaria (RN-BU03); los avisos no bloquean ningún gasto (RN-BU01).

-- Categoría del servicio: el pago al proveedor hereda esta categoría para que el servicio consuma presupuesto (RN-BU06).
alter table subscription add column category_id uuid;
alter table subscription add constraint subscription_category_fk foreign key (owner_id, category_id) references category (owner_id, id);

create table budget (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid        not null references user_profile(id),
  name             text        not null check (length(btrim(name)) > 0),
  category_id      uuid,                                   -- nulo = presupuesto general (todo gasto de consumo, sin duplicar)
  include_children boolean     not null default true,      -- un presupuesto de categoría incluye sus subcategorías (RN-BU02)
  period           text        not null check (period in ('weekly','monthly','yearly')),
  starts_on        date        not null,
  rollover         boolean     not null default false,     -- sin arrastre por defecto (RN-BU04)
  rollover_cap     numeric(14,2) check (rollover_cap is null or rollover_cap >= 0),
  shared_view      text        not null default 'origin_cycle' check (shared_view in ('origin_cycle','receipt_date')),   -- RN-BU07
  status           text        not null default 'active' check (status in ('active','archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          int         not null default 1,
  unique (owner_id, id),
  check (rollover or rollover_cap is null),
  foreign key (owner_id, category_id) references category (owner_id, id)
);
create unique index budget_scope_uq on budget (owner_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), period) where status = 'active';
create trigger budget_touch before update on budget for each row execute function touch_row();

-- El límite puede cambiar: cada versión rige desde el inicio de un período y no reescribe los anteriores.
create table budget_limit (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  budget_id   uuid        not null,
  valid_from  date        not null,
  amount      numeric(14,2) not null check (amount >= 0),
  created_at  timestamptz not null default now(),
  unique (budget_id, valid_from),
  foreign key (owner_id, budget_id) references budget (owner_id, id)
);

-- Niveles de aviso (p. ej. 80 % y 100 %).
create table budget_threshold (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid        not null references user_profile(id),
  budget_id  uuid        not null,
  percent    int         not null check (percent between 1 and 1000),
  unique (budget_id, percent),
  foreign key (owner_id, budget_id) references budget (owner_id, id)
);
