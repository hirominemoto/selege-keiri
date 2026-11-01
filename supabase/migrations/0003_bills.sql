-- =====================================================================
-- 請求の入力（設計 v1.0「3つの目的」の 1. 入力フォーム）
--   1回の入力 = 1枚の請求書。上に請求書全体の項目、下に明細（何行でも）
--   入力中は自由に直せる。請求書を作ったあと（issued）は「作り直す」からだけ直す（作り直しは別の回で追加）
--   0001・0002 のあとに実行する。何度実行しても同じ結果になる
--   旧設計の表（billing_requests・sales・invoices など）は使わないが、動き出すまで消さない
-- =====================================================================

create table if not exists public.bills (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  issue_date        date not null,                       -- 請求日（企業別シート A列）
  accounting_month  date not null check (public.is_month_start(accounting_month)),  -- 計上月（企業別 H列・売上表の月）
  payment_due_date  date not null,                       -- 支払期限（企業別 I列・売上表 N列 入金予定）
  staff_name        text,                                -- 担当（売上表 A列）
  send_method       text not null default 'post' check (send_method in ('post', 'email')),
  memo              text,                                -- 社内メモ（請求書にもExcelにも出さない）
  -- draft=入力中（自由に直せる）/ issued=請求書あり（番号が付いた）
  status            text not null default 'draft' check (status in ('draft', 'issued')),
  invoice_no        text,                                -- 請求書を作ったときに自動で付く（例：2711-01）
  issued_at         timestamptz,
  issued_by         uuid,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (status = 'draft' or (invoice_no is not null and issued_at is not null))
);

comment on table public.bills is '請求（1回の入力 = 1枚の請求書）。入力中 → 請求書あり';

create unique index if not exists bills_invoice_no_uniq on public.bills (invoice_no) where invoice_no is not null;
create index if not exists bills_company_idx on public.bills (company_id, issue_date desc);
create index if not exists bills_month_idx on public.bills (accounting_month);

create table if not exists public.bill_lines (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references public.bills(id) on delete cascade,
  sort        integer not null default 0,
  description text not null check (length(trim(description)) > 0),  -- 内訳（案件名）。書き方は入力者に任せる
  unit_price  integer not null,                          -- 単価（税抜）。値引き・返金はマイナス
  quantity    numeric(10, 2) not null default 1,         -- 個数（人数）
  amount      integer not null,                          -- 金額（税抜）= 単価 × 個数
  taxable     boolean not null default true,             -- false = 消費税がかからない（立替金・通訳の交通費など）
  note        text,                                      -- 備考（企業別シート G列）
  check (amount = round(quantity * unit_price))
);

create index if not exists bill_lines_bill_idx on public.bill_lines (bill_id, sort);

-- ---------------------------------------------------------------------
-- 請求書を作ったあとは、ここで直接は変えられない（作り直しの処理だけが変える）
-- ---------------------------------------------------------------------

create or replace function public.bill_is_unlocked()
returns boolean
language sql
stable
as $$ select coalesce(current_setting('app.bill_unlock', true), '') = 'on' $$;

create or replace function public.guard_bills()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.invoice_no is not null then
      raise exception '請求は「入力中」から作ります';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'draft' then
      return old;
    end if;
    raise exception '請求書を作った請求は消せません';
  end if;
  if new.company_id is distinct from old.company_id and old.status <> 'draft' then
    raise exception '請求書を作ったあとは企業を変えられません';
  end if;
  if old.status <> 'draft' and not public.bill_is_unlocked() then
    raise exception '請求書を作ったあとは、ここでは直せません。「作り直す」から直してください';
  end if;
  if old.status = 'draft' and new.status <> 'draft' and not public.bill_is_unlocked() then
    raise exception '請求書は「請求書を作る」ボタンから作ります';
  end if;
  return new;
end;
$$;

drop trigger if exists bills_guard on public.bills;
create trigger bills_guard
  before insert or update or delete on public.bills
  for each row execute function public.guard_bills();

create or replace function public.guard_bill_lines()
returns trigger
language plpgsql
as $$
declare
  st text;
begin
  select status into st from public.bills where id = coalesce(new.bill_id, old.bill_id);
  if st is distinct from 'draft' and st is not null and not public.bill_is_unlocked() then
    raise exception '請求書を作ったあとは明細を直せません。「作り直す」から直してください';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists bill_lines_guard on public.bill_lines;
create trigger bill_lines_guard
  before insert or update or delete on public.bill_lines
  for each row execute function public.guard_bill_lines();

-- ---------------------------------------------------------------------
-- 保存（請求書全体と明細をまとめて。全部できるか、何もしないか）
--   p_id が空なら新しく作る。p_version は画面を開いたときの版（ほかの人の更新を上書きしないため）
--   p_bill：{ company_id, issue_date, accounting_month, payment_due_date, staff_name, send_method, memo }
--   p_lines：[{ description, unit_price, quantity, taxable, note }, ...]（並び順のまま保存）
-- ---------------------------------------------------------------------

create or replace function public.bill_save(p_id uuid, p_version integer, p_bill jsonb, p_lines jsonb)
returns uuid
language plpgsql
as $$
declare
  b    public.bills;
  bid  uuid;
  ln   jsonb;
  i    integer := 0;
  qty  numeric;
  price integer;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '明細を1行以上入れてください';
  end if;

  if p_id is null then
    insert into public.bills (company_id, issue_date, accounting_month, payment_due_date, staff_name, send_method, memo)
    values ((p_bill ->> 'company_id')::uuid,
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
      company_id       = (p_bill ->> 'company_id')::uuid,
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
    insert into public.bill_lines (bill_id, sort, description, unit_price, quantity, amount, taxable, note)
    values (bid, i, trim(ln ->> 'description'), price, qty, round(qty * price)::integer,
            coalesce((ln ->> 'taxable')::boolean, true), nullif(trim(ln ->> 'note'), ''));
    i := i + 1;
  end loop;

  return bid;
end;
$$;

-- 入力中の請求を消す（請求書を作ったものは消せない）
create or replace function public.bill_delete_draft(p_id uuid)
returns void
language plpgsql
as $$
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  delete from public.bills where id = p_id;   -- 入力中でなければ guard_bills が止める
end;
$$;

-- ---------------------------------------------------------------------
-- 作成者・版番号・変更履歴・アクセス制御（0001 と同じ決まり）
-- ---------------------------------------------------------------------

drop trigger if exists bills_touch on public.bills;
create trigger bills_touch before insert or update on public.bills
  for each row execute function public.touch_row();
drop trigger if exists bills_audit on public.bills;
create trigger bills_audit after insert or update or delete on public.bills
  for each row execute function public.write_audit();
drop trigger if exists bill_lines_audit on public.bill_lines;
create trigger bill_lines_audit after insert or update or delete on public.bill_lines
  for each row execute function public.write_audit();

do $$
declare
  t text;
begin
  foreach t in array array['bills', 'bill_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member())',
                   t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_admin())',
                   t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())',
                   t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_admin())',
                   t || '_delete', t);
  end loop;
end;
$$;
