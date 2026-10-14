-- 0001_extensions_and_helpers.sql
-- Extensiones y funciones auxiliares. Generado desde docs/especificacion/12-modelo-de-datos.md §2.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

create extension if not exists btree_gist;

create or replace function touch_row() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.version    := old.version + 1;
  return new;
end $$;

create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE_ROW: % no admite % (use una reversión)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;
