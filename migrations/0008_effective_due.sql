-- 0008_effective_due.sql
-- Vencimiento efectivo de un cargo (E2): un cargo ya pagado que recibe un ajuste positivo (cambio de cuota)
-- vence cuando vence ese ajuste, no cuando venció el cargo original. Una migración aplicada es inmutable.

create view v_charge_due as
select b.obligation_id, b.owner_id,
       case when b.applied_total >= b.issued_amount and a.min_due is not null then a.min_due else mc.due_date end as effective_due_date
from v_obligation_balance b
join member_charge mc on mc.obligation_id = b.obligation_id
left join lateral (
  select min(ca.due_date) as min_due from charge_adjustment ca
  where ca.obligation_id = b.obligation_id and ca.status = 'active' and ca.amount > 0 and ca.due_date is not null
) a on true;
