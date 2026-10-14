-- 0101_e2_courtesy_calendar_loans.sql
-- Entrega 2: cortesías, calendario, préstamos. Generado desde docs/especificacion/12-modelo-de-datos.md §8.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

create table courtesy (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid        not null references user_profile(id),
  seat_id      uuid        not null,
  kind         text        not null check (kind in ('cycles','until_date','permanent')),
  starts_on    date        not null,
  until_date   date,
  cycles_total int,
  cycles_used  int         not null default 0,
  reason       text        not null,
  status       text        not null default 'active' check (status in ('active','ended')),
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz,
  foreign key (owner_id, seat_id) references seat (owner_id, id),
  check ((kind = 'cycles'     and cycles_total >= 1)
      or (kind = 'until_date' and until_date is not null)
      or (kind = 'permanent'))
);

create table calendar_change (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid        not null references user_profile(id),
  subscription_id    uuid        not null,
  kind               text        not null check (kind in ('shift_renewal','change_interval','suspend','reactivate','advance_renewal')),
  effective_on       date        not null,
  before_terms_id    uuid,
  after_terms_id     uuid,
  old_current_end    date,
  new_current_end    date,
  reason             text        not null,
  preview            jsonb       not null,                -- ciclos y cargos afectados tal como se mostró
  confirmed_by       uuid        not null,
  created_at         timestamptz not null default now(),
  foreign key (owner_id, subscription_id) references subscription (owner_id, id)
);

-- E2: solo préstamos OTORGADOS a un contacto (por conversión de deuda o manuales). E3 amplía.
create table loan (
  id                         uuid primary key default gen_random_uuid(),
  owner_id                   uuid          not null references user_profile(id),
  contact_id                 uuid          not null,
  direction                  text          not null default 'lent' check (direction in ('lent')),
  principal                  numeric(14,2) not null check (principal > 0),
  currency                   char(3)       not null default 'PEN' check (currency = 'PEN'),
  opened_on                  date          not null,
  origin                     text          not null check (origin in ('manual','debt_conversion')),
  interest_mode              text          not null default 'none' check (interest_mode in ('none')),
  disbursement_operation_id  uuid,                           -- solo si el dinero salió de una cuenta propia
  status                     text          not null default 'open' check (status in ('open','closed','cancelled')),
  note                       text,
  created_at                 timestamptz   not null default now(),
  updated_at                 timestamptz   not null default now(),
  version                    int           not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, contact_id) references contact (owner_id, id),
  foreign key (owner_id, disbursement_operation_id) references financial_operation (owner_id, id)
);
create trigger loan_touch before update on loan for each row execute function touch_row();

create table loan_component (
  obligation_id         uuid primary key,
  owner_id              uuid          not null,
  contact_id            uuid          not null,
  loan_id               uuid          not null,
  concept               text          not null,             -- 'Netflix — plaza 1'
  period_label          text,                               -- 'ciclo 4-mar → 4-abr'
  origin_obligation_id  uuid,                               -- cargo de origen (trazabilidad)
  amount                numeric(14,2) not null check (amount > 0),
  due_date              date,
  created_at            timestamptz   not null default now(),
  foreign key (owner_id, obligation_id, contact_id) references receivable_obligation (owner_id, id, contact_id),
  foreign key (owner_id, loan_id)              references loan (owner_id, id),
  foreign key (owner_id, origin_obligation_id) references receivable_obligation (owner_id, id)
);

create table debt_conversion (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid        not null references user_profile(id),
  contact_id    uuid        not null,
  loan_id       uuid        not null unique,
  converted_on  date        not null,
  trigger       text        not null check (trigger in ('exit','individual_switch','courtesy_choice','manual')),
  reason        text        not null,
  created_by    uuid        not null,
  created_at    timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, contact_id) references contact (owner_id, id),
  foreign key (owner_id, loan_id)    references loan (owner_id, id)
);

create table debt_conversion_item (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid          not null references user_profile(id),
  conversion_id         uuid          not null,
  source_obligation_id  uuid          not null,
  target_obligation_id  uuid          not null,
  amount                numeric(14,2) not null check (amount > 0),
  status                text          not null default 'active' check (status in ('active','void')),
  foreign key (owner_id, conversion_id)        references debt_conversion (owner_id, id),
  foreign key (owner_id, source_obligation_id) references receivable_obligation (owner_id, id),
  foreign key (owner_id, target_obligation_id) references receivable_obligation (owner_id, id),
  unique (conversion_id, source_obligation_id)
);

-- Las conversiones reducen el pendiente de origen y el componente nuevo lo abre: la deuda total no cambia.
create or replace view v_obligation_balance as
select o.id as obligation_id, o.owner_id, o.contact_id, o.kind,
       b.amount                         as issued_amount,
       coalesce(adj.total, 0.00)           as adjustments_total,
       coalesce(al.total, 0.00)            as applied_total,
       coalesce(cv.total, 0.00)            as converted_total,
       b.amount + coalesce(adj.total, 0.00) - coalesce(al.total, 0.00) - coalesce(cv.total, 0.00) as pending_amount
from receivable_obligation o
join lateral (
  select mc.net_amount as amount from member_charge mc
   where mc.obligation_id = o.id and mc.status = 'issued'
  union all
  select lc.amount from loan_component lc where lc.obligation_id = o.id
) b on true
left join lateral (select sum(a.amount) total from charge_adjustment a
                   where a.obligation_id = o.id and a.status = 'active') adj on true
left join lateral (select sum(p.amount) total from payment_allocation p
                   where p.obligation_id = o.id and p.status = 'active') al on true
left join lateral (select sum(i.amount) total from debt_conversion_item i
                   where i.source_obligation_id = o.id and i.status = 'active') cv on true;
