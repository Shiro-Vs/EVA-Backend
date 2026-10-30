-- 0404_e6_account_deletion.sql
-- Eliminar la cuenta y los datos (09 §8). Una migración aplicada es inmutable.
-- Tras borrar todo, un token todavía vigente NO debe volver a crear un perfil vacío: queda solo el identificador (sin datos personales)
-- durante unos días —lo que dura un token— y el trabajo diario lo elimina.

create table deleted_user (
  id          uuid primary key,
  deleted_at  timestamptz not null default now()
);
