-- =====================================================================
-- セレッジ 請求・支払・収支管理システム  初期スキーマ
--
-- 方針（設計書 v0.2 より）
--   ・売上台帳（sales）を売上の正本にする。請求書・入金はそこにぶら下がる
--   ・同じ情報を複数の表に持たない（支出は payables と monthly_costs だけ）
--   ・金額は円の整数。税は請求書ごとに1回だけ計算する
--   ・発行済み請求書は書き換えない。取消は状態で持ち、集計から外す
--   ・誰がいつ何を変えたかを audit_log に残す
--   ・同時編集は version 列で検出する（楽観ロック）
-- =====================================================================

-- gen_random_uuid() は PostgreSQL 13 以降の標準機能なので拡張は不要

-- ---------------------------------------------------------------------
-- 共通の関数
-- ---------------------------------------------------------------------

-- 行の作成者・更新者・版番号をそろえる
create or replace function public.touch_row()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
    new.version := 1;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := auth.uid();
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

-- 月を表す日付は「その月の1日」にそろえる
create or replace function public.is_month_start(d date)
returns boolean
language sql
immutable
as $$ select d is null or extract(day from d) = 1 $$;

-- 消費税の計算（端数の扱いはここ1か所で決める）
--   mode: 'ceil' = 切り上げ / 'floor' = 切り捨て / 'round' = 四捨五入
create or replace function public.calc_tax(p_taxable bigint, p_rate numeric, p_mode text)
returns integer
language sql
immutable
as $$
  select case p_mode
    when 'ceil'  then ceil(p_taxable * p_rate)
    when 'floor' then floor(p_taxable * p_rate)
    when 'round' then round(p_taxable * p_rate)
  end::integer
$$;

-- ---------------------------------------------------------------------
-- 利用者と役割
-- ---------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'pending' check (role in ('admin', 'viewer', 'pending')),
  created_at   timestamptz not null default now()
);

comment on table public.profiles is '利用者。admin=入力できる人、viewer=見るだけの人、pending=管理者の承認待ち（何も見られない）';

-- 新しい利用者が登録されたらプロフィールを作る。
-- 最初の1人は管理者。2人目からは「承認待ち」で、管理者が役割を決めるまで何も見られない
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when exists (select 1 from public.profiles where role = 'admin') then 'pending' else 'admin' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'viewer')) $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

-- ---------------------------------------------------------------------
-- 変更履歴
-- ---------------------------------------------------------------------

create table public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     uuid,
  action     text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  actor      uuid,
  at         timestamptz not null default now(),
  old_data   jsonb,
  new_data   jsonb
);

create index audit_log_row_idx on public.audit_log (table_name, row_id, at desc);

create or replace function public.write_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- id 列のない表（app_settings）もあるので、jsonb 経由で取り出す
  insert into public.audit_log (table_name, row_id, action, actor, old_data, new_data)
  values (
    tg_table_name,
    nullif(coalesce(to_jsonb(new), to_jsonb(old)) ->> 'id', '')::uuid,
    tg_op,
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------
-- 設定（税率・端数・請求書番号の頭・自社情報）
-- ---------------------------------------------------------------------

create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value, note) values
  ('tax_rate',       '0.10',   '消費税率'),
  ('tax_rounding',   '"ceil"', '端数処理。今の請求書シートは切り上げ（要確認）'),
  ('invoice_prefix', 'null',   '請求書番号の頭（例：26）。決まるまで未設定'),
  ('issuer',         '{}',     '請求書に印字する自社情報（社名・住所・電話・登録番号・振込先）');

-- ---------------------------------------------------------------------
-- 企業
-- ---------------------------------------------------------------------

create table public.companies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  honorific          text not null default '御中',
  postal_code        text,
  address1           text,
  address2           text,
  department         text,
  contact_name       text,
  phone              text,
  email              text,
  send_method        text not null default 'post' check (send_method in ('post', 'email')),
  -- 入金予定日：請求月の何か月後の何日か（日が空なら月末）
  payment_due_months integer not null default 1 check (payment_due_months between 0 and 6),
  payment_due_day    integer check (payment_due_day between 1 and 31),
  note               text,
  is_active          boolean not null default true,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1
);

comment on column public.companies.payment_due_months is '入金予定日：請求月の何か月後か（翌月末なら1）';
comment on column public.companies.payment_due_day    is '入金予定日の日。空なら月末';

-- 旧Excelの表記ゆれ（「興和工業株式会社1」「渡邉金属」など）を企業に結びつける
create table public.company_aliases (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  alias      text not null unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 契約（1つの企業に複数。一期生・二期生も別の契約）
-- ---------------------------------------------------------------------

create table public.contracts (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id),
  name                 text not null,                       -- 例：在留サポートサービス
  cohort               text,                                -- 例：二期生
  kind                 text not null default 'monthly' check (kind in ('monthly', 'one_time')),
  quantity             numeric(10, 2) not null default 1,   -- 人数など
  unit_price           integer not null default 0,          -- 税抜単価
  taxable              boolean not null default true,
  -- 「◯月分」と請求月の関係：0=請求月と同じ月分、1=翌月分を前請求
  service_month_offset integer not null default 0 check (service_month_offset in (0, 1)),
  total_count          integer check (total_count > 0),     -- 全◯回。空なら上限なし（「26か月目」型）
  count_unit           text not null default '回' check (count_unit in ('回', 'か月')),
  base_count           integer not null default 0 check (base_count >= 0), -- アプリ導入前に請求済みの回数
  start_month          date check (public.is_month_start(start_month)),
  end_month            date check (public.is_month_start(end_month)),
  status               text not null default 'active' check (status in ('active', 'paused', 'ended')),
  description_template text,                                -- 請求書の品名のひな形
  note                 text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (end_month is null or start_month is null or end_month >= start_month)
);

create index contracts_company_idx on public.contracts (company_id);

-- ---------------------------------------------------------------------
-- 請求依頼（契約×対象月の請求の下書き。契約にひもづかない請求もここ）
-- ---------------------------------------------------------------------

create table public.billing_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id),
  contract_id   uuid references public.contracts(id),
  billing_month date not null check (public.is_month_start(billing_month)),  -- 請求する月
  service_month date check (public.is_month_start(service_month)),          -- 「◯月分」
  count_no      integer check (count_no > 0),                                -- 何回目か
  status        text not null default 'draft'
                check (status in ('draft', 'confirmed', 'invoiced', 'cancelled')),
  confirmed_at  timestamptz,
  confirmed_by  uuid,
  note          text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (status in ('draft', 'cancelled') or confirmed_at is not null)
);

-- 同じ契約・同じ「◯月分」の依頼は1件だけ（取消したものは除く）
create unique index billing_requests_contract_month_uniq
  on public.billing_requests (contract_id, coalesce(service_month, billing_month))
  where contract_id is not null and status <> 'cancelled';

create index billing_requests_month_idx on public.billing_requests (billing_month);

create table public.billing_request_lines (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.billing_requests(id) on delete cascade,
  sort        integer not null default 0,
  description text not null,
  quantity    numeric(10, 2) not null default 1,
  unit_price  integer not null,
  amount      integer not null,           -- マイナス（割引・相殺）も可
  taxable     boolean not null default true,
  check (amount = round(quantity * unit_price))
);

-- 確定後の依頼の明細は変えられない
create or replace function public.guard_request_lines()
returns trigger
language plpgsql
as $$
declare
  st text;
begin
  select status into st from public.billing_requests
   where id = coalesce(new.request_id, old.request_id);
  if st is not null and st <> 'draft' then
    raise exception '確定済みの請求依頼の明細は変更できません（状態：%）', st;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger billing_request_lines_guard
  before insert or update or delete on public.billing_request_lines
  for each row execute function public.guard_request_lines();

-- ---------------------------------------------------------------------
-- 請求書（発行した1枚。中身は発行時点の写し）
-- ---------------------------------------------------------------------

create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  invoice_no          text not null,
  is_legacy           boolean not null default false,  -- 旧Excelから取り込んだ番号（重複があり得る）
  issue_date          date not null,
  payment_due_date    date,
  status              text not null default 'issued' check (status in ('issued', 'cancelled')),
  -- 宛名（発行時点の写し）
  bill_to_name        text not null,
  honorific           text not null default '御中',
  postal_code         text,
  address1            text,
  address2            text,
  department          text,
  contact_name        text,
  -- 送付
  send_method         text not null default 'post' check (send_method in ('post', 'email')),
  send_to_email       text,
  sent_on             date,
  -- 金額（発行時点で確定）
  subtotal_taxable    integer not null,
  subtotal_nontaxable integer not null,
  tax_rate            numeric(4, 2) not null,
  tax_amount          integer not null,
  total               integer not null,
  pdf_path            text,
  replaces_invoice_id uuid references public.invoices(id),
  cancel_reason       text,
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (total = subtotal_taxable + subtotal_nontaxable + tax_amount),
  check (status = 'issued' or (cancelled_at is not null and cancel_reason is not null))
);

-- アプリで採番した番号は重複させない
create unique index invoices_no_uniq on public.invoices (invoice_no) where not is_legacy;
create index invoices_company_idx on public.invoices (company_id, issue_date desc);

create table public.invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id),
  sort        integer not null default 0,
  description text not null,
  quantity    numeric(10, 2) not null,
  unit_price  integer not null,
  amount      integer not null,
  taxable     boolean not null
);

-- 発行済み請求書は、送付の記録・PDF・取消以外は書き換えない
create or replace function public.guard_invoices()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '請求書は削除できません。取消してください';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception '取消した請求書は元に戻せません';
  end if;
  if (new.company_id, new.invoice_no, new.is_legacy, new.issue_date, new.payment_due_date,
      new.bill_to_name, new.honorific, new.postal_code, new.address1, new.address2,
      new.department, new.contact_name, new.subtotal_taxable, new.subtotal_nontaxable,
      new.tax_rate, new.tax_amount, new.total, new.replaces_invoice_id)
     is distinct from
     (old.company_id, old.invoice_no, old.is_legacy, old.issue_date, old.payment_due_date,
      old.bill_to_name, old.honorific, old.postal_code, old.address1, old.address2,
      old.department, old.contact_name, old.subtotal_taxable, old.subtotal_nontaxable,
      old.tax_rate, old.tax_amount, old.total, old.replaces_invoice_id) then
    raise exception '発行済みの請求書の内容は変更できません。取消して再発行してください';
  end if;
  return new;
end;
$$;

create trigger invoices_guard
  before update or delete on public.invoices
  for each row execute function public.guard_invoices();

create or replace function public.guard_invoice_lines()
returns trigger
language plpgsql
as $$
begin
  raise exception '発行済みの請求書の明細は変更できません';
end;
$$;

create trigger invoice_lines_guard
  before update or delete on public.invoice_lines
  for each row execute function public.guard_invoice_lines();

-- 請求書番号の採番（「頭-連番」。同時に発行しても重ならない）
create table public.invoice_counters (
  prefix   text primary key,
  last_seq integer not null default 0
);

create or replace function public.next_invoice_no(p_prefix text)
returns text
language plpgsql
as $$
declare
  seq integer;
begin
  if p_prefix is null or p_prefix = '' then
    raise exception '請求書番号の頭が設定されていません（設定画面で決めてください）';
  end if;
  insert into public.invoice_counters as c (prefix, last_seq)
  values (p_prefix, 1)
  on conflict (prefix) do update set last_seq = c.last_seq + 1
  returning last_seq into seq;
  return p_prefix || '-' || seq;
end;
$$;

-- ---------------------------------------------------------------------
-- 売上台帳（すべての売上の正本）
-- ---------------------------------------------------------------------

create table public.sales (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  billing_request_id uuid unique references public.billing_requests(id),  -- 依頼1件から売上は1件だけ
  accounting_month   date not null check (public.is_month_start(accounting_month)),
  description        text not null,
  amount_taxable     integer not null default 0,   -- 税がかかる部分（税抜）
  amount_nontaxable  integer not null default 0,   -- 税がかからない部分（立替金など）
  tax_amount         integer not null default 0,   -- 請求書を作らない売上のときだけ使う
  needs_invoice      boolean not null default true,
  invoice_id         uuid references public.invoices(id),
  status             text not null default 'active' check (status in ('active', 'cancelled')),
  note               text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (needs_invoice or invoice_id is null),
  check (needs_invoice = false or tax_amount = 0)
);

create index sales_month_idx on public.sales (accounting_month);
create index sales_company_idx on public.sales (company_id);
create index sales_invoice_idx on public.sales (invoice_id);

-- ---------------------------------------------------------------------
-- 入金と、その割り当て（まとめ払い・不足・過入金に対応）
-- ---------------------------------------------------------------------

create table public.receipts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id),
  received_on date not null,
  amount      integer not null check (amount > 0),
  payer_name  text,
  note        text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1
);

create table public.receipt_allocations (
  id         uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  invoice_id uuid references public.invoices(id),   -- 請求書のある売上
  sale_id    uuid references public.sales(id),      -- 請求書のない売上
  amount     integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  check ((invoice_id is null) <> (sale_id is null))
);

create index receipt_allocations_invoice_idx on public.receipt_allocations (invoice_id);
create index receipt_allocations_sale_idx on public.receipt_allocations (sale_id);

-- 1回の振込より多くは割り当てられない
create or replace function public.check_allocation_total()
returns trigger
language plpgsql
as $$
declare
  total_alloc bigint;
  rcpt_amount integer;
begin
  select coalesce(sum(amount), 0) into total_alloc
    from public.receipt_allocations where receipt_id = new.receipt_id;
  select amount into rcpt_amount from public.receipts where id = new.receipt_id;
  if total_alloc > rcpt_amount then
    raise exception '割り当ての合計（%円）が入金額（%円）を超えています', total_alloc, rcpt_amount;
  end if;
  return new;
end;
$$;

create constraint trigger receipt_allocations_total
  after insert or update on public.receipt_allocations
  deferrable initially deferred
  for each row execute function public.check_allocation_total();

-- ---------------------------------------------------------------------
-- 支払い（受け取った請求書と支出）
-- ---------------------------------------------------------------------

create table public.vendors (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique,
  note text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1
);

-- 毎月の★印の支払い（レンタルサーバー、メール配信、家賃など）のひな形
create table public.recurring_payments (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors(id),
  description    text not null,
  default_amount integer not null,
  is_active      boolean not null default true,
  note           text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1
);

create table public.payables (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references public.vendors(id),
  description   text not null,
  amount        integer not null,     -- 相殺などのマイナスも可
  kind          text not null default 'normal' check (kind in ('normal', 'refund')),  -- refund=顧客への返金
  payment_month date not null check (public.is_month_start(payment_month)),         -- 支払う月
  invoice_date  date,                 -- 相手の請求書の日付
  due_date      date,                 -- 支払期限
  requested_at  timestamptz,          -- 総務へ依頼した日時（システムが記録）
  requested_by  uuid,
  paid_on       date,
  status        text not null default 'registered'
                check (status in ('registered', 'requested', 'paid', 'cancelled')),
  recurring_id  uuid references public.recurring_payments(id),
  file_path     text,
  note          text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (status not in ('requested', 'paid') or requested_at is not null),
  check (status <> 'paid' or paid_on is not null)
);

-- 同じ★印の支払いを同じ月に2回作らない
create unique index payables_recurring_month_uniq
  on public.payables (recurring_id, payment_month)
  where recurring_id is not null and status <> 'cancelled';

create index payables_month_idx on public.payables (payment_month);

-- ---------------------------------------------------------------------
-- 月次の固定費（人件費・社会保険など。家賃は支払いのほうで扱う）
-- ---------------------------------------------------------------------

create table public.monthly_costs (
  id       uuid primary key default gen_random_uuid(),
  month    date not null check (public.is_month_start(month)),
  category text not null check (category in
           ('人件費', '社会保険', 'クレジットカード', '経費', 'NTT料金', '海外送金', 'インセンティブ', 'その他')),
  amount   integer not null,
  note     text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1
);

-- 「その他」以外は、同じ月に同じ項目を2回入れない
create unique index monthly_costs_month_category_uniq
  on public.monthly_costs (month, category) where category <> 'その他';

-- ---------------------------------------------------------------------
-- 見るための集計（取消は自動で外す）
-- ---------------------------------------------------------------------

-- 請求書ごとの入金済み額と残り
create view public.invoice_balances
with (security_invoker = true) as
select
  i.id as invoice_id,
  i.company_id,
  i.invoice_no,
  i.issue_date,
  i.payment_due_date,
  i.total,
  coalesce(sum(a.amount), 0)::integer as received,
  (i.total - coalesce(sum(a.amount), 0))::integer as remaining
from public.invoices i
left join public.receipt_allocations a on a.invoice_id = i.id
where i.status = 'issued'
group by i.id;

-- ---------------------------------------------------------------------
-- トリガーの取り付け（作成者・版番号・変更履歴）
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'contracts', 'billing_requests', 'invoices', 'sales',
    'receipts', 'vendors', 'recurring_payments', 'payables', 'monthly_costs'
  ] loop
    execute format('create trigger %I before insert or update on public.%I
                    for each row execute function public.touch_row()', t || '_touch', t);
  end loop;

  foreach t in array array[
    'companies', 'company_aliases', 'contracts', 'billing_requests', 'billing_request_lines',
    'invoices', 'invoice_lines', 'sales', 'receipts', 'receipt_allocations',
    'vendors', 'recurring_payments', 'payables', 'monthly_costs', 'app_settings', 'profiles'
  ] loop
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function public.write_audit()', t || '_audit', t);
  end loop;
end;
$$;

-- app_settings は id 列がないので、変更履歴の row_id は空になる
-- profiles の変更（役割の変更）も履歴に残る

-- ---------------------------------------------------------------------
-- 行レベルのアクセス制御（RLS）
--   ・ログインした利用者は見られる
--   ・入力・変更は admin だけ
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'company_aliases', 'contracts', 'billing_requests', 'billing_request_lines',
    'invoices', 'invoice_lines', 'sales', 'receipts', 'receipt_allocations',
    'vendors', 'recurring_payments', 'payables', 'monthly_costs', 'app_settings', 'invoice_counters'
  ] loop
    execute format('alter table public.%I enable row level security', t);
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

alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

alter table public.audit_log enable row level security;
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_admin());
