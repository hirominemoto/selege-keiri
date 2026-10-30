-- =====================================================================
-- 明細の行を契約につなげる（回数を正しく数えるため）
--   企業のページの「当月の請求を入力」から始めると、継続中の契約の行が回数つきで並ぶ。
--   契約につながらない行（通訳の交通費など）も、これまでどおり自由に入れられる
--   0003 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない
-- =====================================================================

alter table public.bill_lines add column if not exists contract_id uuid references public.contracts(id);
alter table public.bill_lines add column if not exists count_no integer;          -- 何回目か（契約の行だけ）
alter table public.bill_lines add column if not exists service_month date;       -- 「◯月分」（契約の行だけ）

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bill_lines_count_no_check') then
    alter table public.bill_lines add constraint bill_lines_count_no_check check (count_no is null or count_no > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bill_lines_service_month_check') then
    alter table public.bill_lines add constraint bill_lines_service_month_check
      check (service_month is null or public.is_month_start(service_month));
  end if;
end;
$$;

create index if not exists bill_lines_contract_idx on public.bill_lines (contract_id) where contract_id is not null;

-- 契約ごとの「次は何回目か」：アプリ導入前の回数と、アプリで請求した最大の回数の大きいほう + 1
--   p_company_id が空なら全企業の契約
create or replace function public.contract_next_counts(p_company_id uuid default null)
returns table (contract_id uuid, last_count integer, next_count integer, last_service_month date)
language sql
stable
as $$
  select c.id,
         nullif(greatest(c.base_count, coalesce(max(l.count_no), 0)), 0),
         greatest(c.base_count, coalesce(max(l.count_no), 0)) + 1,
         greatest(c.legacy_last_service_month, max(l.service_month))
    from public.contracts c
    left join public.bill_lines l on l.contract_id = c.id
   where p_company_id is null or c.company_id = p_company_id
   group by c.id
$$;

-- 保存：契約・回数・◯月分も受け取る（0003 の bill_save を置き換える。引数は同じ）
create or replace function public.bill_save(p_id uuid, p_version integer, p_bill jsonb, p_lines jsonb)
returns uuid
language plpgsql
as $$
declare
  b     public.bills;
  bid   uuid;
  co_id uuid := (p_bill ->> 'company_id')::uuid;
  ln    jsonb;
  i     integer := 0;
  qty   numeric;
  price integer;
  ct_id uuid;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '明細を1行以上入れてください';
  end if;

  if p_id is null then
    insert into public.bills (company_id, issue_date, accounting_month, payment_due_date, staff_name, send_method, memo)
    values (co_id,
            (p_bill ->> 'issue_date')::date,
            date_trunc('month', (p_bill ->> 'accounting_month')::date)::date,
            (p_bill ->> 'payment_due_date')::date,
            nullif(trim(p_bill ->> 'staff_name'), ''),
            coalesce(p_bill ->> 'send_method', 'post'),
            nullif(trim(p_bill ->> 'memo'), ''))
    returning id into bid;
  else
    select * into b from public.bills where id = p_id for update;
    if b.id is null then
      raise exception 'この請求は見つかりません（消された可能性があります）';
    end if;
    if b.status <> 'draft' then
      raise exception '請求書を作ったあとは、ここでは直せません。「作り直す」から直してください';
    end if;
    if p_version is distinct from b.version then
      raise exception 'ほかの人が先に更新しました' using errcode = '40001';
    end if;
    update public.bills set
      company_id       = co_id,
      issue_date       = (p_bill ->> 'issue_date')::date,
      accounting_month = date_trunc('month', (p_bill ->> 'accounting_month')::date)::date,
      payment_due_date = (p_bill ->> 'payment_due_date')::date,
      staff_name       = nullif(trim(p_bill ->> 'staff_name'), ''),
      send_method      = coalesce(p_bill ->> 'send_method', 'post'),
      memo             = nullif(trim(p_bill ->> 'memo'), '')
    where id = p_id;
    delete from public.bill_lines where bill_id = p_id;
    bid := p_id;
  end if;

  for ln in select * from jsonb_array_elements(p_lines) loop
    qty   := coalesce((ln ->> 'quantity')::numeric, 1);
    price := (ln ->> 'unit_price')::integer;
    ct_id := nullif(ln ->> 'contract_id', '')::uuid;
    if ct_id is not null and not exists (select 1 from public.contracts where id = ct_id and company_id = co_id) then
      raise exception '%行目の契約は、選んだ企業の契約ではありません', i + 1;
    end if;
    insert into public.bill_lines (bill_id, sort, description, unit_price, quantity, amount, taxable, note,
                                   contract_id, count_no, service_month)
    values (bid, i, trim(ln ->> 'description'), price, qty, round(qty * price)::integer,
            coalesce((ln ->> 'taxable')::boolean, true), nullif(trim(ln ->> 'note'), ''),
            ct_id,
            case when ct_id is null then null else nullif(ln ->> 'count_no', '')::integer end,
            case when ct_id is null then null
                 else date_trunc('month', nullif(ln ->> 'service_month', '')::date)::date end);
    i := i + 1;
  end loop;

  return bid;
end;
$$;
