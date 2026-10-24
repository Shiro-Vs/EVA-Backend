-- 0302_e4_occurred_time.sql
-- Hora local del movimiento (opcional). Los comprobantes (Yape, Plin, bancos) la traen y permite comparar duplicados con precisión (RN-DU02).
-- La fecha sigue siendo la que manda en reglas y reportes; la hora solo ordena y afina.
alter table financial_operation add column occurred_time time;
alter table movement_proposal   add column occurred_time time;
