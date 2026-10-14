-- 0004_billing.sql
-- Cargos, cobros y pagos. Generado desde docs/especificacion/12-modelo-de-datos.md §5.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

-- Clave común de todo lo que un contacto debe al administrador
create table receivable_obligation (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  contact_id  uuid        not null,
  kind        text        not null check (kind in ('subscription_charge','loan_component')),
  currency    char(3)     not null default 'PEN' check (currency = 'PEN'),
  created_at  timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, id, contact_id),
  foreign key (owner_id, contact_id) references contact (owner_id, id)
);
create index obligation_contact_idx on receivable_obligation (owner_id, contact_id);

create table member_charge (
  obligation_id      uuid primary key,
  owner_id           uuid          not null,
  contact_id         uuid          not null,
  seat_id            uuid          not null,
  cycle_id           uuid          not null,
  due_date           date          not null,
  quota_snapshot     numeric(14,2) not null,
  gross_amount       numeric(14,2) not null check (gross_amount >= 0),
  exemption_amount   numeric(14,2) not null default 0 check (exemption_amount >= 0),
  net_amount         numeric(14,2) generated always as (gross_amount - exemption_amount) stored,
  mode               text          not null check (mode in ('full_cycle','trial_free','partial_charged','courtesy','manual')),
  calc_snapshot      jsonb         not null,                -- r, B, g, prorrateo, regla@versión, redondeo
  status             text          not null default 'issued' check (status in ('issued','void')),
  void_reason        text,
  voided_at          timestamptz,
  created_at         timestamptz   not null default now(),
  check (exemption_amount <= gross_amount),
  check (status = 'issued' or void_reason is not null),
  foreign key (owner_id, obligation_id, contact_id) references receivable_obligation (owner_id, id, contact_id),
  foreign key (owner_id, seat_id)  references seat (owner_id, id),
  foreign key (owner_id, cycle_id) references billing_cycle (owner_id, id),
  unique (seat_id, cycle_id)                                -- un cargo por plaza y ciclo (RN-CH01)
);
create index member_charge_due_idx   on member_charge (owner_id, due_date) where status = 'issued';
create index member_charge_cycle_idx on member_charge (cycle_id);

create table charge_adjustment (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid          not null references user_profile(id),
  obligation_id  uuid          not null,
  amount         numeric(14,2) not null check (amount <> 0),   -- firmado: + aumenta, − descuenta
  kind           text          not null check (kind in ('quota_change','early_exit','manual','forgiveness','other')),
  due_date       date,
  group_id       uuid,                                          -- agrupa diferencias "juntas"
  reason         text          not null,
  status         text          not null default 'active' check (status in ('active','void')),
  created_by     uuid          not null,
  created_at     timestamptz   not null default now(),
  voided_at      timestamptz,
  foreign key (owner_id, obligation_id) references receivable_obligation (owner_id, id)
);
create index charge_adjustment_obl_idx on charge_adjustment (obligation_id) where status = 'active';

-- Un cobro = UN ingreso real. Su reparto está en payment_allocation.
create table receipt (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid          not null references user_profile(id),
  contact_id    uuid          not null,
  operation_id  uuid          not null unique,
  amount        numeric(14,2) not null check (amount > 0),
  received_on   date          not null,
  note          text,
  status        text          not null default 'active' check (status in ('active','reversed')),
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),
  version       int           not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, contact_id)   references contact (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id)
);
create index receipt_contact_idx on receipt (owner_id, contact_id, received_on desc);
create trigger receipt_touch before update on receipt for each row execute function touch_row();

create table payment_allocation (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid          not null references user_profile(id),
  receipt_id       uuid          not null,
  obligation_id    uuid          not null,
  amount           numeric(14,2) not null check (amount > 0),
  origin           text          not null default 'manual' check (origin in ('manual','reservation','system')),
  status           text          not null default 'active' check (status in ('active','released')),
  released_reason  text,
  released_at      timestamptz,
  created_by       uuid          not null,
  created_at       timestamptz   not null default now(),
  foreign key (owner_id, receipt_id)    references receipt (owner_id, id),
  foreign key (owner_id, obligation_id) references receivable_obligation (owner_id, id),
  check (status = 'active' or released_reason is not null)
);
create index alloc_receipt_idx    on payment_allocation (receipt_id)    where status = 'active';
create index alloc_obligation_idx on payment_allocation (obligation_id) where status = 'active';

-- Anticipo: dinero sin aplicar con destino por defecto. No crea dinero ni garantiza precio.
create table credit_reservation (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid          not null references user_profile(id),
  receipt_id              uuid          not null,
  target_subscription_id  uuid          not null,
  amount                  numeric(14,2) not null check (amount >= 0),
  status                  text          not null default 'active' check (status in ('active','consumed','released')),
  note                    text,
  created_at              timestamptz   not null default now(),
  updated_at              timestamptz   not null default now(),
  version                 int           not null default 1,
  foreign key (owner_id, receipt_id)             references receipt (owner_id, id),
  foreign key (owner_id, target_subscription_id) references subscription (owner_id, id),
  check (status <> 'active' or amount > 0)
);
create index reservation_receipt_idx on credit_reservation (receipt_id) where status = 'active';
create trigger reservation_touch before update on credit_reservation for each row execute function touch_row();

-- Devolución: solicitada/programada ≠ dinero ya devuelto (RN-X06)
create table refund (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid          not null references user_profile(id),
  receipt_id    uuid          not null,
  contact_id    uuid          not null,
  amount        numeric(14,2) not null check (amount > 0),
  status        text          not null default 'planned' check (status in ('planned','paid','cancelled')),
  planned_on    date,
  operation_id  uuid          unique,                        -- salida real cuando status = 'paid'
  reason        text          not null,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now(),
  version       int           not null default 1,
  foreign key (owner_id, receipt_id)   references receipt (owner_id, id),
  foreign key (owner_id, contact_id)   references contact (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id),
  check (status <> 'paid' or operation_id is not null)
);
create trigger refund_touch before update on refund for each row execute function touch_row();

create table supplier_payment (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid          not null references user_profile(id),
  cycle_id                  uuid          not null,
  operation_id              uuid          not null unique,
  amount_real               numeric(14,2) not null check (amount_real > 0),
  announced_price_snapshot  numeric(14,2) not null,
  paid_on                   date          not null,
  status                    text          not null default 'active' check (status in ('active','reversed')),
  created_at                timestamptz   not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, cycle_id)     references billing_cycle (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id)
);
create unique index supplier_payment_active_uq on supplier_payment (cycle_id) where status = 'active';
