-- 0003_subscriptions.sql
-- Servicios, calendario y plazas. Generado desde docs/especificacion/12-modelo-de-datos.md §4.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

create table subscription (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid        not null references user_profile(id),
  name                  text        not null check (length(btrim(name)) > 0),
  provider              text,
  mode                  text        not null check (mode in ('personal','shared')),
  capacity              int         not null check (capacity >= 1),
  preferred_account_id  uuid,
  color                 text,
  icon                  text,
  status                text        not null default 'active' check (status in ('active','suspended','archived')),
  currency              char(3)     not null default 'PEN' check (currency = 'PEN'),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               int         not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, preferred_account_id) references account (owner_id, id),
  check (mode <> 'personal' or capacity = 1)
);
create index subscription_owner_status_idx on subscription (owner_id, status);
create trigger subscription_touch before update on subscription for each row execute function touch_row();

-- Versiones del precio y calendario con vigencia [valid_from, valid_to)
create table subscription_terms (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid          not null references user_profile(id),
  subscription_id  uuid          not null,
  valid_from       date          not null,
  valid_to         date,
  announced_price  numeric(14,2) not null check (announced_price >= 0),
  interval_unit    text          not null check (interval_unit in ('day','week','month','year')),
  interval_count   int           not null check (interval_count >= 1),
  anchor_date      date          not null,                  -- última fecha confirmada por el proveedor
  reason           text,
  created_by       uuid          not null,
  created_at       timestamptz   not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, subscription_id) references subscription (owner_id, id),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (subscription_id with =, daterange(valid_from, valid_to, '[)') with &&)
);

create table billing_cycle (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid        not null references user_profile(id),
  subscription_id  uuid        not null,
  seq              int         not null check (seq >= 1),
  start_date       date        not null,
  end_date         date        not null,                    -- excluido
  terms_id         uuid,
  terms_snapshot   jsonb       not null,                    -- { announcedPrice, interval, anchor, baseDays }
  created_at       timestamptz not null default now(),
  unique (owner_id, id),
  unique (subscription_id, start_date),
  unique (subscription_id, seq),
  foreign key (owner_id, subscription_id) references subscription (owner_id, id),
  foreign key (owner_id, terms_id)        references subscription_terms (owner_id, id),
  check (end_date > start_date),
  exclude using gist (subscription_id with =, daterange(start_date, end_date, '[)') with &&)
);
create index billing_cycle_sub_start_idx on billing_cycle (subscription_id, start_date desc);

create table membership (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid        not null references user_profile(id),
  subscription_id     uuid        not null,
  contact_id          uuid,
  is_owner            boolean     not null default false,
  start_date          date        not null,
  end_date            date,
  scheduled_end_date  date,                                 -- baja programada (E2)
  status              text        not null default 'active' check (status in ('active','ending','ended')),
  end_reason          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             int         not null default 1,
  unique (owner_id, id),
  unique (owner_id, id, subscription_id),
  foreign key (owner_id, subscription_id) references subscription (owner_id, id),
  foreign key (owner_id, contact_id)      references contact (owner_id, id),
  check ((is_owner and contact_id is null) or (not is_owner and contact_id is not null)),
  check (end_date is null or end_date >= start_date)
);
create unique index membership_owner_uq   on membership (subscription_id) where is_owner and status <> 'ended';
create unique index membership_contact_uq on membership (subscription_id, contact_id)
  where not is_owner and status <> 'ended';
create trigger membership_touch before update on membership for each row execute function touch_row();

create table seat (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid        not null references user_profile(id),
  membership_id    uuid        not null,
  subscription_id  uuid        not null,
  label            text        not null,                    -- 'Cuenta 1', 'Pantalla 2'
  start_date       date        not null,
  end_date         date,
  created_at       timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, membership_id, subscription_id) references membership (owner_id, id, subscription_id),
  check (end_date is null or end_date >= start_date)
);
create index seat_sub_idx on seat (subscription_id) where end_date is null;

create table seat_terms (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid          not null references user_profile(id),
  seat_id               uuid          not null,
  valid_from            date          not null,
  valid_to              date,
  quota                 numeric(14,2) not null check (quota >= 0),
  free_days_threshold   int           check (free_days_threshold >= 0),   -- excepción de g para esta plaza
  reason                text,
  created_by            uuid          not null,
  created_at            timestamptz   not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, seat_id) references seat (owner_id, id),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (seat_id with =, daterange(valid_from, valid_to, '[)') with &&)
);
