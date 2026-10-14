-- 0006_views_and_invariants.sql
-- Vistas e invariantes (E1). Generado desde docs/especificacion/12-modelo-de-datos.md §7.
-- Una migración aplicada es inmutable: los cambios van en una migración nueva.

create view v_account_balance as
select e.owner_id, e.account_id, sum(e.amount) as balance
from account_entry e
group by e.owner_id, e.account_id;

create view v_obligation_balance as
select o.id as obligation_id, o.owner_id, o.contact_id, o.kind,
       b.amount                         as issued_amount,
       coalesce(adj.total, 0.00)           as adjustments_total,
       coalesce(al.total, 0.00)            as applied_total,
       0.00::numeric                       as converted_total,
       b.amount + coalesce(adj.total, 0.00) - coalesce(al.total, 0.00) as pending_amount
from receivable_obligation o
join lateral (
  select mc.net_amount as amount
  from member_charge mc
  where mc.obligation_id = o.id and mc.status = 'issued'
) b on true
left join lateral (
  select sum(a.amount) as total from charge_adjustment a
  where a.obligation_id = o.id and a.status = 'active'
) adj on true
left join lateral (
  select sum(p.amount) as total from payment_allocation p
  where p.obligation_id = o.id and p.status = 'active'
) al on true;

create view v_receipt_availability as
select r.id as receipt_id, r.owner_id, r.contact_id,
       r.amount                                           as received,
       coalesce(al.total, 0.00)                              as applied,
       coalesce(rf.total, 0.00)                              as refunded,
       r.amount - coalesce(al.total, 0.00) - coalesce(rf.total, 0.00)                           as unapplied,
       coalesce(rs.total, 0.00)                              as reserved,
       r.amount - coalesce(al.total, 0.00) - coalesce(rf.total, 0.00) - coalesce(rs.total, 0.00)   as free
from receipt r
left join lateral (select sum(amount) total from payment_allocation
                   where receipt_id = r.id and status = 'active') al on true
left join lateral (select sum(amount) total from refund
                   where receipt_id = r.id and status in ('planned','paid')) rf on true
left join lateral (select sum(amount) total from credit_reservation
                   where receipt_id = r.id and status = 'active') rs on true
where r.status = 'active';

create view v_charge_status as
select b.*, mc.due_date, mc.seat_id, mc.cycle_id,
       case
         when b.issued_amount + b.adjustments_total = 0                   then 'exempt'
         when b.converted_total > 0 and b.pending_amount = 0              then 'converted'
         when b.pending_amount = 0                                        then 'paid'
         when b.applied_total = 0                                         then 'unpaid'
         else 'partial'
       end as payment_status
from v_obligation_balance b
join member_charge mc on mc.obligation_id = b.obligation_id;

create or replace function check_allocation_invariants() returns trigger language plpgsql as $$
declare v_rc receipt%rowtype; v_ob_contact uuid; v_applied numeric; v_refunded numeric; v_pending numeric;
begin
  if new.status <> 'active' then return null; end if;

  select * into v_rc from receipt where id = new.receipt_id;
  if v_rc.status <> 'active' then
    raise exception 'ALLOCATION_RECEIPT_NOT_ACTIVE' using errcode = 'check_violation';
  end if;

  select contact_id into v_ob_contact from receivable_obligation where id = new.obligation_id;
  if v_ob_contact <> v_rc.contact_id then
    raise exception 'ALLOCATION_CONTACT_MISMATCH' using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount),0) into v_applied  from payment_allocation where receipt_id = new.receipt_id and status = 'active';
  select coalesce(sum(amount),0) into v_refunded from refund where receipt_id = new.receipt_id and status in ('planned','paid');
  if v_applied + v_refunded > v_rc.amount then
    raise exception 'ALLOCATION_EXCEEDS_RECEIPT' using errcode = 'check_violation';
  end if;

  select pending_amount into v_pending from v_obligation_balance where obligation_id = new.obligation_id;
  if v_pending is null or v_pending < 0 then
    raise exception 'ALLOCATION_EXCEEDS_OBLIGATION' using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger payment_allocation_invariants
  after insert or update on payment_allocation deferrable initially deferred
  for each row execute function check_allocation_invariants();
