-- 0207_e3_reconciliation.sql
-- Entrega 3, bloque 7: conciliación de saldos. Una migración aplicada es inmutable.
-- Primero se revisan y corrigen movimientos; solo si la diferencia no se explica se registra un AJUSTE con fecha y motivo (RN-CO01/CO02).
-- El ajuste es una operación `adjustment` con concepto `reconciliation`: línea propia en reportes, ni ingreso ganado ni gasto de consumo (D-22).

create table reconciliation (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid        not null references user_profile(id),
  account_id              uuid        not null,
  as_of                   date        not null,
  registered_balance      numeric(14,2) not null,   -- saldo según EVA a esa fecha (antes del ajuste)
  real_balance            numeric(14,2) not null,   -- saldo real informado por el usuario
  difference              numeric(14,2) not null,   -- real − registrado
  adjustment_operation_id uuid,
  reason                  text,
  created_by              uuid        not null,
  created_at              timestamptz not null default now(),
  foreign key (owner_id, account_id)              references account (owner_id, id),
  foreign key (owner_id, adjustment_operation_id) references financial_operation (owner_id, id),
  check (difference = real_balance - registered_balance),
  check ((difference = 0) = (adjustment_operation_id is null)),
  check (difference = 0 or reason is not null)
);
create index reconciliation_account_idx on reconciliation (account_id, created_at desc);
