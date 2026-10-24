-- 0205_e3_goals.sql
-- Entrega 3, bloque 5: metas de ahorro. Una migración aplicada es inmutable.
-- Una meta es un objetivo monetario con aportes vinculados a cuentas REALES; no es una cuenta bancaria (RN-GO01).
-- Reservar dinero NO crea operaciones ni mueve saldos: solo aparta una parte de lo que ya hay en una cuenta (RN-GO02, A21).

create table goal (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid        not null references user_profile(id),
  name           text        not null check (length(btrim(name)) > 0),
  target_amount  numeric(14,2) not null check (target_amount > 0),
  target_date    date,
  icon           text,
  color          text,
  note           text,
  status         text        not null default 'active' check (status in ('active','archived')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        int         not null default 1,
  unique (owner_id, id)
);
create trigger goal_touch before update on goal for each row execute function touch_row();

-- Aportes firmados por cuenta: + reserva o transferencia vinculada; − liberación o gasto que usó dinero reservado.
create table goal_contribution (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  goal_id       uuid        not null,
  account_id    uuid        not null,
  amount        numeric(14,2) not null check (amount <> 0),
  kind          text        not null check (kind in ('reserve','release','transfer','spend')),
  operation_id  uuid,
  note          text,
  created_by    uuid        not null,
  created_at    timestamptz not null default now(),
  foreign key (owner_id, goal_id)      references goal (owner_id, id),
  foreign key (owner_id, account_id)   references account (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id),
  check ((kind in ('reserve','transfer') and amount > 0) or (kind in ('release','spend') and amount < 0)),
  check ((kind in ('transfer','spend')) = (operation_id is not null))
);
create index goal_contribution_goal_idx on goal_contribution (goal_id, account_id);
create index goal_contribution_account_idx on goal_contribution (account_id);
-- Una transferencia real solo puede vincularse una vez a una meta.
create unique index goal_contribution_transfer_uq on goal_contribution (operation_id) where kind = 'transfer';
