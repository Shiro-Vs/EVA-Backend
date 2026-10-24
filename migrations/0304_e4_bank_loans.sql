-- 0304_e4_bank_loans.sql
-- Entrega 4, bloque 3: préstamos bancarios con documentos (06 §3). Una migración aplicada es inmutable.
-- Solo se guardan datos CONFIRMADOS por documento o por el usuario (RN-B01); lo desconocido queda sin fila (pendiente), nunca estimado.

-- Un documento con datos de un préstamo (resumen, cronograma, estado de cuenta) espera a que el usuario lo asocie a un préstamo.
alter table source_document drop constraint source_document_status_check;
alter table source_document add constraint source_document_status_check check (status in ('received','proposed','failed','discarded','no_transaction','loan_document'));

create table bank_loan (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  name        text        not null check (length(btrim(name)) > 0),
  entity      text,                                        -- banco o entidad
  account_id  uuid,                                        -- cuenta habitual de pago
  note        text,
  status      text        not null default 'active' check (status in ('active','closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int         not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, account_id) references account (owner_id, id)
);
create trigger bank_loan_touch before update on bank_loan for each row execute function touch_row();

-- Datos del préstamo con su origen. Vigente = superseded_at is null; los reemplazados quedan como historial.
create table bank_loan_fact (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid        not null references user_profile(id),
  loan_id        uuid        not null,
  key            text        not null check (key in ('principal','tea','tcea','term_months','installments_count','disbursed_on','first_due_date','monthly_payment','outstanding_balance','loan_number')),
  value          text        not null,
  as_of          date,                                     -- fecha a la que corresponde el dato (p. ej. saldo)
  origin         text        not null check (origin in ('document','user')),
  document_id    uuid,
  confirmed_at   timestamptz not null default now(),
  superseded_at  timestamptz,
  foreign key (owner_id, loan_id)     references bank_loan (owner_id, id),
  foreign key (owner_id, document_id) references source_document (owner_id, id)
);
create unique index bank_loan_fact_current_uq on bank_loan_fact (loan_id, key) where superseded_at is null;

-- Cuotas del calendario. Los importes conservan su valor documental (RN-B09); lo que no consta es NULL.
create table bank_loan_installment (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid        not null references user_profile(id),
  loan_id      uuid        not null,
  no           int         not null check (no >= 1),
  due_date     date        not null,
  principal    numeric(14,2) check (principal is null or principal >= 0),
  interest     numeric(14,2) check (interest is null or interest >= 0),
  insurance    numeric(14,2) check (insurance is null or insurance >= 0),
  fees         numeric(14,2) check (fees is null or fees >= 0),
  total        numeric(14,2) not null check (total >= 0),
  status       text        not null default 'scheduled' check (status in ('scheduled','paid','superseded')),
  origin       text        not null check (origin in ('document','user')),
  document_id  uuid,
  paid_amount  numeric(14,2) not null default 0 check (paid_amount >= 0),
  paid_on      date,                                       -- fecha REAL de pago, distinta del vencimiento (RN-B05)
  created_at   timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, loan_id)     references bank_loan (owner_id, id),
  foreign key (owner_id, document_id) references source_document (owner_id, id)
);
create unique index bank_loan_installment_live_uq on bank_loan_installment (loan_id, no) where status <> 'superseded';

-- Historial de documentos y cambios confirmados (RN-B03, RN-B06).
create table bank_loan_document (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid        not null references user_profile(id),
  loan_id      uuid        not null,
  kind         text        not null check (kind in ('summary','schedule','statement')),
  document_id  uuid,
  summary      jsonb       not null,                       -- qué cambió al confirmar
  confirmed_at timestamptz not null default now(),
  foreign key (owner_id, loan_id)     references bank_loan (owner_id, id),
  foreign key (owner_id, document_id) references source_document (owner_id, id)
);
create index bank_loan_document_idx on bank_loan_document (loan_id, confirmed_at);

-- Pagos reales: un egreso de una cuenta propia. No generan mora ni recalculan nada (RN-B07).
create table bank_loan_payment (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid        not null references user_profile(id),
  loan_id         uuid        not null,
  installment_id  uuid,
  operation_id    uuid        not null unique,
  amount          numeric(14,2) not null check (amount > 0),
  paid_on         date        not null,
  principal       numeric(14,2) check (principal is null or principal >= 0),
  interest        numeric(14,2) check (interest is null or interest >= 0),
  insurance       numeric(14,2) check (insurance is null or insurance >= 0),
  fees            numeric(14,2) check (fees is null or fees >= 0),
  note            text,
  status          text        not null default 'active' check (status in ('active','reversed')),
  created_at      timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, loan_id)        references bank_loan (owner_id, id),
  foreign key (owner_id, installment_id) references bank_loan_installment (owner_id, id),
  foreign key (owner_id, operation_id)   references financial_operation (owner_id, id)
);
create index bank_loan_payment_idx on bank_loan_payment (loan_id, paid_on);
