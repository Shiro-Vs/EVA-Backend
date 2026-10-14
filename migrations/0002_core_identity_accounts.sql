-- 0002_core_identity_accounts.sql
-- Identidad, cuentas y operaciones. Generado desde docs/especificacion/12-modelo-de-datos.md §3.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

create table user_profile (
  id                 uuid primary key,                     -- = id del usuario en Supabase Auth
  display_name       text        not null,
  email              text,
  timezone           text        not null default 'America/Lima',
  currency           char(3)     not null default 'PEN' check (currency = 'PEN'),
  default_free_days  int         not null default 0 check (default_free_days >= 0),   -- g predeterminado
  exit_days_limit    int         check (exit_days_limit >= 0),                        -- L; NULL = siempre termina el ciclo
  preferences        jsonb       not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            int         not null default 1
);
create trigger user_profile_touch before update on user_profile
  for each row execute function touch_row();

create table contact (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  name        text        not null check (length(btrim(name)) > 0),
  phone       text,
  email       text,
  color       text,
  notes       text,
  status      text        not null default 'active' check (status in ('active','archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int         not null default 1,
  unique (owner_id, id)
);
create index contact_owner_status_idx on contact (owner_id, status);
create trigger contact_touch before update on contact for each row execute function touch_row();

create table account (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid        not null references user_profile(id),
  name               text        not null check (length(btrim(name)) > 0),
  type               text        not null check (type in ('bank','savings','cash','wallet','credit')),
  currency           char(3)     not null default 'PEN' check (currency = 'PEN'),
  institution        text,
  color              text,
  icon               text,
  is_default         boolean     not null default false,
  exclude_from_total boolean     not null default false,
  status             text        not null default 'active' check (status in ('active','archived')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            int         not null default 1,
  unique (owner_id, id)
);
create index account_owner_status_idx on account (owner_id, status);
create unique index account_one_default_uq on account (owner_id) where is_default and status = 'active';
create trigger account_touch before update on account for each row execute function touch_row();

create table payment_channel (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references user_profile(id),
  name               text not null,                      -- 'Yape', 'Plin', 'Tarjeta digital X'
  linked_account_id  uuid not null,
  status             text not null default 'active' check (status in ('active','archived')),
  created_at         timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, name),
  foreign key (owner_id, linked_account_id) references account (owner_id, id)
);

create table category (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid        not null references user_profile(id),
  parent_id   uuid,
  name        text        not null check (length(btrim(name)) > 0),
  icon        text,
  color       text,
  status      text        not null default 'active' check (status in ('active','archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     int         not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, parent_id) references category (owner_id, id)
);
-- Nombre único por nivel (dos niveles máximo se valida en la aplicación: D-29)
create unique index category_name_uq on category
  (owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create trigger category_touch before update on category for each row execute function touch_row();

create table financial_operation (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid        not null references user_profile(id),
  kind           text        not null check (kind in ('opening','income','expense','transfer','adjustment','reversal')),
  occurred_on    date        not null,
  description    text        not null default '',
  contact_id     uuid,
  category_id    uuid,
  source         text        not null default 'manual' check (source in ('manual','email','photo','recurring','system')),
  status         text        not null default 'confirmed' check (status in ('confirmed','reversed')),
  reversal_of_id uuid,
  reason         text,
  created_by     uuid        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  version        int         not null default 1,
  unique (owner_id, id),
  foreign key (owner_id, contact_id)     references contact  (owner_id, id),
  foreign key (owner_id, category_id)    references category (owner_id, id),
  foreign key (owner_id, reversal_of_id) references financial_operation (owner_id, id),
  check ((kind = 'reversal') = (reversal_of_id is not null)),
  check (kind <> 'reversal' or reason is not null)
);
create index fin_op_owner_date_idx on financial_operation (owner_id, occurred_on desc);
create trigger fin_op_touch before update on financial_operation for each row execute function touch_row();

-- Efecto firmado sobre una cuenta. Saldo = suma de asientos. Inmutable.
create table account_entry (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid          not null references user_profile(id),
  operation_id  uuid          not null,
  account_id    uuid          not null,
  amount        numeric(14,2) not null check (amount <> 0),
  currency      char(3)       not null default 'PEN' check (currency = 'PEN'),
  created_at    timestamptz   not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id),
  foreign key (owner_id, account_id)   references account (owner_id, id)
);
create index account_entry_account_idx   on account_entry (owner_id, account_id);
create index account_entry_operation_idx on account_entry (operation_id);
create trigger account_entry_immutable before update or delete on account_entry
  for each row execute function forbid_mutation();

-- Desglose de una operación por concepto/categoría. Σ items = total (se valida en la aplicación
-- y con el disparador de §8 en la E3). No es un gasto adicional.
create table operation_item (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid          not null references user_profile(id),
  operation_id  uuid          not null,
  category_id   uuid,
  concept       text          not null,
  amount        numeric(14,2) not null check (amount > 0),
  foreign key (owner_id, operation_id) references financial_operation (owner_id, id),
  foreign key (owner_id, category_id)  references category (owner_id, id)
);
create index operation_item_op_idx on operation_item (operation_id);

-- Se evalúa al confirmar la transacción (diferido), cuando ya existen todos los asientos.
create or replace function check_operation_entries() returns trigger language plpgsql as $$
declare v_kind text; v_sum numeric; v_cnt int;
begin
  select kind into v_kind from financial_operation where id = new.operation_id;
  select coalesce(sum(amount),0), count(*) into v_sum, v_cnt
    from account_entry where operation_id = new.operation_id;

  if v_kind = 'transfer'   and (v_cnt <> 2 or v_sum <> 0)  then raise exception 'OPERATION_TRANSFER_UNBALANCED'  using errcode = 'check_violation'; end if;
  if v_kind = 'income'     and v_sum <= 0                  then raise exception 'OPERATION_INCOME_NOT_POSITIVE'  using errcode = 'check_violation'; end if;
  if v_kind = 'expense'    and v_sum >= 0                  then raise exception 'OPERATION_EXPENSE_NOT_NEGATIVE' using errcode = 'check_violation'; end if;
  if v_kind in ('opening','adjustment') and v_cnt <> 1     then raise exception 'OPERATION_SINGLE_ENTRY_REQUIRED' using errcode = 'check_violation'; end if;
  return null;
end $$;

create constraint trigger account_entry_check_op
  after insert on account_entry deferrable initially deferred
  for each row execute function check_operation_entries();
