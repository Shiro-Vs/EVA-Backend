-- 0007_cycle_emission_flag.sql
-- D-08: los cargos de un ciclo se emiten al empezar ese ciclo. Para anticipos, el administrador puede emitir ciclos
-- futuros a propósito; esta marca los distingue de un ciclo futuro que solo se generó como previsión.
alter table billing_cycle add column emit_charges boolean not null default false;
