-- 0202_e3_cards.sql
-- Entrega 3, bloque 2: tarjeta de crédito. Una migración aplicada es inmutable.
-- La tarjeta SIGUE siendo una cuenta de tipo crédito con un único saldo (RN-T01); aquí solo se añade su configuración,
-- los estados de cuenta tal como los informa el banco y los planes de compras en cuotas. No se guarda CVV ni datos sensibles (RN-T05).

create table credit_account_details (
  account_id   uuid primary key,
  owner_id     uuid        not null references user_profile(id),
  credit_line  numeric(14,2) check (credit_line is null or credit_line >= 0),   -- línea disponible: NO es dinero propio (RN-AC05)
  cutoff_day   int         not null check (cutoff_day between 1 and 31),
  due_day      int         not null check (due_day between 1 and 31),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      int         not null default 1,
  foreign key (owner_id, account_id) references account (owner_id, id)
);
create trigger credit_account_details_touch before update on credit_account_details for each row execute function touch_row();

-- Estado de cuenta informado por el banco: fecha de corte y fecha límite de pago son distintas (RN-T02);
-- el pago total del período no es toda la deuda (RN-T03).
create table card_statement (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid        not null references user_profile(id),
  account_id       uuid        not null,
  cutoff_date      date        not null,
  due_date         date        not null,
  period_total     numeric(14,2) not null check (period_total >= 0),
  minimum_payment  numeric(14,2) not null check (minimum_payment >= 0),
  total_balance    numeric(14,2) check (total_balance is null or total_balance >= 0),
  note             text,
  status           text        not null default 'active' check (status in ('active','void')),
  void_reason      text,
  created_at       timestamptz not null default now(),
  check (due_date >= cutoff_date),
  check (status = 'active' or void_reason is not null),
  unique (owner_id, id),
  foreign key (owner_id, account_id) references account (owner_id, id)
);
create unique index card_statement_cutoff_uq on card_statement (account_id, cutoff_date) where status = 'active';

-- Pagos de la tarjeta (transferencias hacia ella) vinculados a un estado de cuenta: no repiten el gasto (RN-MV04).
create table card_statement_payment (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  statement_id  uuid        not null,
  operation_id  uuid        not null,
  status        text        not null default 'active' check (status in ('active','removed')),
  created_at    timestamptz not null default now(),
  foreign key (owner_id, statement_id) references card_statement (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id)
);
create unique index card_statement_payment_op_uq on card_statement_payment (operation_id) where status = 'active';

-- Compra en cuotas (RN-T04): el consumo es UN gasto con la tarjeta; el plan solo calendariza las cuotas.
create table card_installment_plan (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid        not null references user_profile(id),
  account_id      uuid        not null,
  operation_id    uuid        not null,
  description     text        not null default '',
  principal       numeric(14,2) not null check (principal > 0),
  installments    int         not null check (installments between 2 and 60),
  first_due_date  date        not null,
  status          text        not null default 'active' check (status in ('active','cancelled')),
  created_at      timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, account_id)   references account (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id)
);

create table card_installment (
  id        uuid primary key default gen_random_uuid(),
  owner_id  uuid        not null references user_profile(id),
  plan_id   uuid        not null,
  number    int         not null check (number >= 1),
  due_date  date        not null,
  amount    numeric(14,2) not null check (amount > 0),
  unique (plan_id, number),
  foreign key (owner_id, plan_id) references card_installment_plan (owner_id, id)
);
