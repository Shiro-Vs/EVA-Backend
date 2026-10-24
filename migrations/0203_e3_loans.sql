-- 0203_e3_loans.sql
-- Entrega 3, bloque 3: préstamos completos (recibidos y otorgados). Una migración aplicada es inmutable.
-- Los préstamos por conversión de deuda de servicios siguen funcionando con sus componentes (engine = 'components').
-- Los préstamos nuevos usan un libro de cargos (engine = 'ledger'): cargos con vencimiento y pagos que se aplican a los que el usuario elige.

-- Qué papel juega una operación en los reportes: el capital prestado no es ingreso ganado ni gasto de consumo (RN-MV05).
alter table financial_operation add column concept text not null default 'ordinary'
  check (concept in ('ordinary','loan_disbursement','loan_payment','reconciliation'));

alter table loan drop constraint if exists loan_direction_check;
alter table loan add constraint loan_direction_check check (direction in ('lent','borrowed'));
alter table loan drop constraint if exists loan_interest_mode_check;
alter table loan add constraint loan_interest_mode_check check (interest_mode in ('none','fixed','percent'));
alter table loan alter column contact_id drop not null;
alter table loan
  add column engine           text not null default 'components' check (engine in ('components','ledger')),
  add column counterparty_name text,                       -- prestamista/prestatario que no es un contacto (p. ej. un banco)
  add column interest_amount  numeric(14,2) check (interest_amount is null or interest_amount >= 0),   -- importe fijo por período
  add column interest_rate_bp int check (interest_rate_bp is null or interest_rate_bp >= 0),            -- % por período en puntos básicos (5 % = 500)
  add column interest_base    text check (interest_base in ('original','pending')),
  add column repayment_kind   text check (repayment_kind in ('installments','final_date','open')),
  add column installments     int check (installments is null or installments >= 1),
  add column first_due_date   date,
  add column final_date       date,
  add column payment_order    text not null default 'capital_first' check (payment_order in ('capital_first','interest_first')),
  add column early_payoff     text not null default 'keep' check (early_payoff in ('keep','accrued')),
  add column account_id       uuid,
  add column closed_reason    text,
  add constraint loan_party_chk check (engine = 'components' or (direction = 'lent' and contact_id is not null) or (direction = 'borrowed' and (contact_id is not null or counterparty_name is not null)));

-- Cargos de un préstamo del libro: capital, interés y mora, cada uno con su vencimiento (nulo en préstamos sin fecha).
create table loan_charge (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid        not null references user_profile(id),
  loan_id          uuid        not null,
  concept          text        not null check (concept in ('principal','interest','late_fee')),
  installment_no   int,
  period_no        int,
  due_date         date,
  amount           numeric(14,2) not null check (amount > 0),
  status           text        not null default 'active' check (status in ('active','void','capitalized')),
  source_charge_id uuid,
  note             text,
  created_at       timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, loan_id) references loan (owner_id, id)
);
create index loan_charge_loan_idx on loan_charge (loan_id, due_date);
create unique index loan_charge_interest_uq on loan_charge (loan_id, period_no) where concept = 'interest' and status <> 'void';
create unique index loan_charge_fee_uq on loan_charge (source_charge_id, period_no) where concept = 'late_fee' and status <> 'void';

-- Un pago = UN movimiento real de dinero (RN-MV07: el total y sus partes son el mismo movimiento).
create table loan_payment (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  loan_id       uuid        not null,
  operation_id  uuid        not null unique,
  paid_on       date        not null,
  amount        numeric(14,2) not null check (amount > 0),
  unapplied     numeric(14,2) not null default 0 check (unapplied >= 0),   -- sobrepago conservado como saldo a favor (RN-L11)
  kind          text        not null default 'regular' check (kind in ('regular','payoff')),
  status        text        not null default 'active' check (status in ('active','reversed')),
  reason        text,
  created_at    timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, loan_id)      references loan (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id)
);

create table loan_allocation (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  payment_id  uuid        not null,
  charge_id   uuid        not null,
  amount      numeric(14,2) not null check (amount > 0),
  foreign key (owner_id, payment_id) references loan_payment (owner_id, id),
  foreign key (owner_id, charge_id)  references loan_charge (owner_id, id)
);
create index loan_allocation_charge_idx on loan_allocation (charge_id);

-- Capitalización: el interés pendiente pasa a capital SOLO cuando el usuario lo pide y lo confirma (RN-L09).
create table loan_capitalization (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid        not null references user_profile(id),
  loan_id             uuid        not null,
  capitalized_on      date        not null,
  amount              numeric(14,2) not null check (amount > 0),
  principal_charge_id uuid        not null,
  created_by          uuid        not null,
  created_at          timestamptz not null default now(),
  foreign key (owner_id, loan_id)             references loan (owner_id, id),
  foreign key (owner_id, principal_charge_id) references loan_charge (owner_id, id)
);
