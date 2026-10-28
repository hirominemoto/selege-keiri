-- =====================================================================
-- セレッジ 請求・支払・収支管理システム  初期スキーマ
--
-- 方針（設計書 v0.3 ＋ 10/28 の回答 ＋ ペチちゃんのレビュー）
--   ・売上台帳（sales）を売上の正本にする。請求書・入金はそこにぶら下がる
--   ・同じ情報を複数の表に持たない（支出は payables と monthly_costs だけ）
--   ・金額は円の整数。税は請求書ごとに1回だけ計算する
--   ・社長の承認・「確定」の手順は作らない
--   ・請求書の流れは「下書き → 送付OK → 送付済み」
--       下書き   ：自由に保存・修正できる
--       送付OK   ：その時点の内容を固定する。番号・売上ができる。直すときは送付OKを取り消して再確認
--       送付済み ：郵送した／セレッジ担当がメールで送った。直すときは同じ番号で訂正版を作る
--   ・請求書のない売上は送付OKを通らずに売上にできる
--   ・状態を変える操作はデータベースの関数にまとめ、二重に押しても二重にならないようにする
--   ・誰がいつ何をしたかを、各表の列と audit_log の両方に残す
--   ・同時編集は version 列で検出する（楽観ロック）
--
-- まだ決めていないこと（新しいセレッジ担当者との打ち合わせ後）
--   ・送付OKを押せる人（今はログインして入力できる人なら誰でも押せる）
--   ・送付OKまわりの具体的な画面操作
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

-- その月の末日
create or replace function public.month_end(d date)
returns date
language sql
immutable
as $$ select (date_trunc('month', d) + interval '1 month - 1 day')::date $$;

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

comment on table public.profiles is '利用者。admin=入力できる人（根元・南條さん・セレッジ担当）、viewer=見るだけの人（社長）、pending=管理者の承認待ち（何も見られない）';

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
-- 設定（税率・端数・年度・請求書番号・自社情報）
-- ---------------------------------------------------------------------

create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value, note) values
  ('tax_rate',                '0.10',          '消費税率'),
  ('tax_rounding',            '"ceil"',        '消費税の端数処理。ceil=切り上げ（今の請求書と同じ）/ floor=切り捨て / round=四捨五入'),
  ('fiscal_year_start_month', '8',             '年度の始まりの月（セレッジは7月決算なので8）'),
  ('invoice_no_year',         '"fiscal_end"',  '請求書番号の頭2桁。fiscal_end=年度が終わる年（2026年8月〜2027年7月は27）/ calendar=暦年'),
  ('issuer',                  '{}',            '請求書に印字する自社情報（社名・住所・電話・登録番号・振込先）');

create or replace function public.setting_text(p_key text, p_default text)
returns text
language sql
stable
as $$ select coalesce((select value #>> '{}' from public.app_settings where key = p_key), p_default) $$;

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
  -- 送り方：post=郵送（南條さんが印刷して投函）/ email=セレッジ担当がメールで直接送る（★の企業）
  send_method        text not null default 'post' check (send_method in ('post', 'email')),
  -- 入金予定日：請求月の何か月後の何日か（日が空なら月末）
  payment_due_months integer not null default 1 check (payment_due_months between 0 and 6),
  payment_due_day    integer check (payment_due_day between 1 and 31),
  note               text,
  is_active          boolean not null default true,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1
);

comment on column public.companies.send_method        is 'post=郵送 / email=セレッジ担当がメールで直接送る';
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
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id),
  name                      text not null,                       -- 例：在留サポートサービス
  cohort                    text,                                -- 例：二期生
  kind                      text not null default 'monthly' check (kind in ('monthly', 'one_time')),
  quantity                  numeric(10, 2) not null default 1,   -- 人数など
  unit_price                integer not null default 0,          -- 税抜単価
  taxable                   boolean not null default true,
  -- 「◯月分」と請求月の関係：0=請求月と同じ月分、1=翌月分を前請求
  service_month_offset      integer not null default 0 check (service_month_offset in (0, 1)),
  total_count               integer check (total_count > 0),     -- 全◯回。空なら上限なし（「26か月目」型）
  count_unit                text not null default '回' check (count_unit in ('回', 'か月')),
  base_count                integer not null default 0 check (base_count >= 0), -- アプリ導入前に請求済みの回数
  -- 旧Excelで請求済みの最後の「◯月分」。これ以前の月は「Excelで請求済み」と表示する
  legacy_last_service_month date check (public.is_month_start(legacy_last_service_month)),
  start_month               date check (public.is_month_start(start_month)),
  end_month                 date check (public.is_month_start(end_month)),
  status                    text not null default 'active' check (status in ('active', 'paused', 'ended')),
  description_template      text,                                -- 請求書の品名のひな形
  note                      text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (end_month is null or start_month is null or end_month >= start_month)
);

create index contracts_company_idx on public.contracts (company_id);

-- ---------------------------------------------------------------------
-- 請求書（1枚。下書き → 送付OK → 送付済み）
--   請求依頼より先に作る（請求依頼が請求書を指すため）
-- ---------------------------------------------------------------------

create table public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  billing_month       date not null check (public.is_month_start(billing_month)),  -- 請求する月
  invoice_no          text,                 -- 初めて送付OKにしたときに付く（例：2711-01）。訂正版も同じ番号
  revision            integer not null default 1 check (revision >= 1),            -- 版。訂正版で増える
  replaces_invoice_id uuid references public.invoices(id),                         -- 訂正版のとき、前の版
  correction_reason   text,
  is_legacy           boolean not null default false,  -- 旧Excelから取り込んだ番号（重複があり得る）
  status              text not null default 'draft'
                      check (status in ('draft', 'send_ok', 'sent', 'superseded', 'cancelled')),
  -- 下書きでも決めておけるもの（空なら送付OKのときに決まる）
  issue_date          date,                 -- 請求日。空なら請求月の末日
  payment_due_date    date,                 -- 入金予定日。空なら企業の設定から
  send_method         text not null default 'post' check (send_method in ('post', 'email')),
  send_to_email       text,
  note                text,
  -- 宛名（送付OKのときに企業から写す）
  bill_to_name        text,
  honorific           text,
  postal_code         text,
  address1            text,
  address2            text,
  department          text,
  contact_name        text,
  -- 金額（送付OKのときに計算して固定）
  subtotal_taxable    integer,
  subtotal_nontaxable integer,
  tax_rate            numeric(4, 2),
  tax_amount          integer,
  total               integer,
  pdf_path            text,
  -- 誰がいつ
  send_ok_at          timestamptz,
  send_ok_by          uuid,
  sent_on             date,
  sent_at             timestamptz,
  sent_by             uuid,
  reopened_at         timestamptz,          -- 最後に送付OKを取り消した日時
  reopened_by         uuid,
  reopen_reason       text,
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  cancel_reason       text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (total is null or total = subtotal_taxable + subtotal_nontaxable + tax_amount),
  -- 送付OKから先は、番号・請求日・宛名・金額がそろっている
  check (status in ('draft', 'cancelled') or (
         invoice_no is not null and issue_date is not null and bill_to_name is not null
         and total is not null and tax_rate is not null)),
  check (status in ('draft', 'cancelled') or is_legacy or (send_ok_at is not null and send_ok_by is not null)),
  check (status not in ('sent', 'superseded') or sent_on is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and cancel_reason is not null)),
  check ((revision = 1) = (replaces_invoice_id is null)),
  check (replaces_invoice_id is null or correction_reason is not null)
);

comment on column public.invoices.status is 'draft=下書き / send_ok=送付OK / sent=送付済み / superseded=訂正済み（旧版）/ cancelled=取消';

-- アプリで付けた番号は、同じ番号・同じ版を2枚作らない
create unique index invoices_no_rev_uniq on public.invoices (invoice_no, revision)
  where not is_legacy and invoice_no is not null;
-- 同じ番号で有効な（送付OK・送付済みの）版は1枚だけ
create unique index invoices_no_live_uniq on public.invoices (invoice_no)
  where not is_legacy and status in ('send_ok', 'sent');
-- 1枚の請求書に対して、作りかけの訂正版は1枚だけ
create unique index invoices_replaces_uniq on public.invoices (replaces_invoice_id)
  where replaces_invoice_id is not null and status <> 'cancelled';
create index invoices_company_idx on public.invoices (company_id, billing_month desc);
create index invoices_status_idx on public.invoices (status, send_method);

-- 請求書番号の採番（「年度2桁＋月2桁-その月の連番2桁」。同時に押しても重ならない）
create table public.invoice_counters (
  prefix   text primary key,          -- 例：2711
  last_seq integer not null default 0
);

create or replace function public.invoice_no_prefix(p_billing_month date)
returns text
language plpgsql
stable
as $$
declare
  start_m integer := public.setting_text('fiscal_year_start_month', '8')::integer;
  basis   text    := public.setting_text('invoice_no_year', 'fiscal_end');
  y       integer := extract(year from p_billing_month);
  m       integer := extract(month from p_billing_month);
  yy      integer;
begin
  if basis = 'calendar' or start_m = 1 then
    yy := y;
  elsif m >= start_m then
    yy := y + 1;     -- 例：2026年11月は2027年7月に終わる年度 → 27
  else
    yy := y;
  end if;
  return lpad((yy % 100)::text, 2, '0') || lpad(m::text, 2, '0');
end;
$$;

create or replace function public.next_invoice_no(p_billing_month date)
returns text
language plpgsql
as $$
declare
  p   text;
  seq integer;
begin
  if p_billing_month is null then
    raise exception '請求月が入っていません';
  end if;
  p := public.invoice_no_prefix(p_billing_month);
  insert into public.invoice_counters as c (prefix, last_seq)
  values (p, 1)
  on conflict (prefix) do update set last_seq = c.last_seq + 1
  returning last_seq into seq;
  -- 2桁にそろえる。100枚目からは3桁のまま（lpad は長い値を切り詰めるので、桁数を合わせて渡す）
  return p || '-' || lpad(seq::text, greatest(2, length(seq::text)), '0');
end;
$$;

-- ---------------------------------------------------------------------
-- 請求依頼（契約×◯月分の請求内容。契約にひもづかない請求もここ）
--   セレッジ担当が入力するもの。請求書に載る前・下書きの請求書に載っている間は自由に直せる
-- ---------------------------------------------------------------------

create table public.billing_requests (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  contract_id       uuid references public.contracts(id),
  kind              text not null default 'normal' check (kind in ('normal', 'additional', 'correction')),
  origin_request_id uuid references public.billing_requests(id),   -- 追加・訂正のとき、元の依頼
  reason            text,                                          -- 追加・訂正の理由
  billing_month     date not null check (public.is_month_start(billing_month)),  -- 請求する月
  service_month     date check (public.is_month_start(service_month)),          -- 「◯月分」
  count_no          integer check (count_no > 0),                                -- 何回目か
  needs_invoice     boolean not null default true,     -- false=請求書を作らない売上（甲賀市など）
  invoice_id        uuid references public.invoices(id),  -- 載っている請求書（いまの版）
  status            text not null default 'active' check (status in ('active', 'cancelled')),
  note              text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check ((kind = 'normal') = (origin_request_id is null)),
  check (kind = 'normal' or reason is not null),
  check (needs_invoice or invoice_id is null)
);

comment on column public.billing_requests.kind is 'normal=通常 / additional=追加 / correction=訂正';

-- 同じ契約・同じ「◯月分」の通常の依頼は1件だけ（取消したもの・追加・訂正は除く）
create unique index billing_requests_contract_month_uniq
  on public.billing_requests (contract_id, coalesce(service_month, billing_month))
  where contract_id is not null and kind = 'normal' and status <> 'cancelled';

-- 同じ契約で同じ回数は1回だけ
create unique index billing_requests_contract_count_uniq
  on public.billing_requests (contract_id, count_no)
  where contract_id is not null and kind = 'normal' and count_no is not null and status <> 'cancelled';

create index billing_requests_month_idx on public.billing_requests (billing_month);
create index billing_requests_invoice_idx on public.billing_requests (invoice_id);

create table public.billing_request_lines (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.billing_requests(id) on delete cascade,
  sort            integer not null default 0,
  description     text not null,
  quantity        numeric(10, 2) not null default 1,
  unit_price      integer not null,
  amount          integer not null,           -- マイナス（割引・相殺）も可。0円は不可
  taxable         boolean not null default true,  -- false=消費税がかからない行（立替金など）
  contract_amount integer,                    -- 契約どおりならいくらか（違えば画面で色を付ける）
  check (amount = round(quantity * unit_price)),
  check (amount <> 0)
);

-- 次の回数の候補（＝取り込み時の回数とアプリで請求した最大の回数の大きいほう＋1）
create or replace function public.next_count_no(p_contract_id uuid)
returns integer
language sql
stable
as $$
  select greatest(
           (select base_count from public.contracts where id = p_contract_id),
           (select max(count_no) from public.billing_requests
             where contract_id = p_contract_id and kind = 'normal' and status <> 'cancelled')
         ) + 1
$$;

-- ---------------------------------------------------------------------
-- 売上台帳（すべての売上の正本）
-- ---------------------------------------------------------------------

create table public.sales (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id),
  billing_request_id uuid references public.billing_requests(id),
  accounting_month   date not null check (public.is_month_start(accounting_month)),  -- 請求ベース
  description        text not null,
  amount_taxable     integer not null default 0,   -- 税がかかる部分（税抜）
  amount_nontaxable  integer not null default 0,   -- 税がかからない部分（立替金など）
  tax_amount         integer not null default 0,   -- 請求書を作らない売上のときだけ使う
  needs_invoice      boolean not null default true,
  invoice_id         uuid references public.invoices(id),
  status             text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason      text,
  note               text,
  created_at timestamptz, created_by uuid, updated_at timestamptz, updated_by uuid,
  version    integer not null default 1,
  check (needs_invoice or invoice_id is null),
  check (needs_invoice = false or tax_amount = 0),
  check (status = 'active' or cancel_reason is not null)
);

-- 1つの依頼から、有効な売上は1件だけ
create unique index sales_request_active_uniq on public.sales (billing_request_id)
  where billing_request_id is not null and status = 'active';
create index sales_month_idx on public.sales (accounting_month);
create index sales_company_idx on public.sales (company_id);
create index sales_invoice_idx on public.sales (invoice_id);

-- ---------------------------------------------------------------------
-- 請求書の明細（送付OKのときに請求依頼から写す。写したあとは書き換えない）
-- ---------------------------------------------------------------------

create table public.invoice_lines (
  id              uuid primary key default gen_random_uuid(),
  invoice_id      uuid not null references public.invoices(id),
  request_id      uuid references public.billing_requests(id),
  sale_id         uuid references public.sales(id),
  sort            integer not null default 0,
  description     text not null,
  quantity        numeric(10, 2) not null,
  unit_price      integer not null,
  amount          integer not null,
  taxable         boolean not null,
  contract_amount integer
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

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

-- ---------------------------------------------------------------------
-- 守り（トリガー）
-- ---------------------------------------------------------------------

-- 請求依頼が「固まっている」か
--   ・送付OK・送付済みの請求書に載っている
--   ・請求書を作らない依頼で、すでに売上になっている
create or replace function public.request_is_locked(r public.billing_requests)
returns boolean
language sql
stable
as $$
  select
    (r.invoice_id is not null and exists (
       select 1 from public.invoices i where i.id = r.invoice_id and i.status in ('send_ok', 'sent')))
    or
    (r.invoice_id is null and exists (
       select 1 from public.sales s where s.billing_request_id = r.id and s.status = 'active'))
$$;

create or replace function public.guard_billing_requests()
returns trigger
language plpgsql
as $$
declare
  tgt public.invoices;
  cur public.invoices;
begin
  if tg_op = 'DELETE' then
    if public.request_is_locked(old) then
      raise exception '送付OKにした請求の依頼は削除できません';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'cancelled' then
    raise exception '取消した請求依頼は変更できません';
  end if;

  -- 固まっている依頼は、訂正版への付け替え以外は変えられない
  if tg_op = 'UPDATE' and public.request_is_locked(old) then
    if (to_jsonb(new) - array['invoice_id', 'version', 'updated_at', 'updated_by'])
       is distinct from (to_jsonb(old) - array['invoice_id', 'version', 'updated_at', 'updated_by']) then
      raise exception '送付OKのあとは請求内容を変更できません。送付OKを取り消すか、訂正版を作ってください';
    end if;
    if new.invoice_id is distinct from old.invoice_id then
      select * into tgt from public.invoices where id = new.invoice_id;
      if not coalesce(tgt.status = 'draft' and tgt.replaces_invoice_id = old.invoice_id, false) then
        raise exception '送付OKのあとは請求書を付け替えられません';
      end if;
    end if;
    return new;
  end if;

  if new.status = 'cancelled' and new.invoice_id is not null then
    raise exception '請求書に載っている依頼は取消できません。先に請求書から外してください';
  end if;

  -- 作りかけの訂正版からは外せない（外すと、送付済みの前の版と食い違うため）
  if tg_op = 'UPDATE' and old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    select * into cur from public.invoices where id = old.invoice_id;
    if cur.status = 'draft' and cur.replaces_invoice_id is not null then
      raise exception '訂正版から依頼は外せません。やめるときは訂正版を取消してください';
    end if;
  end if;

  -- 請求書に載せる・付け替えるとき、載ったまま企業・請求月・請求書の要否を変えるとき
  if new.invoice_id is not null and (
       tg_op = 'INSERT'
       or new.invoice_id is distinct from old.invoice_id
       or new.company_id is distinct from old.company_id
       or new.billing_month is distinct from old.billing_month
       or new.needs_invoice is distinct from old.needs_invoice
       or new.status is distinct from old.status) then
    select * into tgt from public.invoices where id = new.invoice_id;
    if tg_op = 'UPDATE' and old.invoice_id is not null then
      select * into cur from public.invoices where id = old.invoice_id;
    end if;
    if tgt.status = 'sent' and cur.status = 'cancelled' and cur.replaces_invoice_id = tgt.id then
      null;  -- 作りかけの訂正版を取消して、元の版に戻すとき
    elsif tgt.status <> 'draft' then
      raise exception '下書きの請求書にだけ載せられます（この請求書の状態：%）', tgt.status;
    elsif tgt.company_id <> new.company_id then
      raise exception '別の企業の請求書には載せられません';
    elsif tgt.billing_month <> new.billing_month then
      raise exception '請求月の違う請求書には載せられません';
    elsif new.status <> 'active' or not new.needs_invoice then
      raise exception 'この依頼は請求書に載せられません';
    end if;
  end if;
  return new;
end;
$$;

create trigger billing_requests_guard
  before insert or update or delete on public.billing_requests
  for each row execute function public.guard_billing_requests();

create or replace function public.guard_request_lines()
returns trigger
language plpgsql
as $$
declare
  r public.billing_requests;
begin
  select * into r from public.billing_requests where id = coalesce(new.request_id, old.request_id);
  if r.id is not null and (r.status = 'cancelled' or public.request_is_locked(r)) then
    raise exception '送付OKのあとは請求内容を変更できません。送付OKを取り消すか、訂正版を作ってください';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger billing_request_lines_guard
  before insert or update or delete on public.billing_request_lines
  for each row execute function public.guard_request_lines();

-- 請求書の状態の動き方
--   draft → send_ok / cancelled
--   send_ok → sent / draft（送付OKの取り消し）/ cancelled
--   sent → superseded（訂正版が送付OKになったとき）/ cancelled
create or replace function public.guard_invoices()
returns trigger
language plpgsql
as $$
declare
  frozen text[] := array[
    'company_id', 'billing_month', 'invoice_no', 'revision', 'replaces_invoice_id', 'correction_reason',
    'is_legacy', 'issue_date', 'payment_due_date', 'send_method', 'send_to_email',
    'bill_to_name', 'honorific', 'postal_code', 'address1', 'address2', 'department', 'contact_name',
    'subtotal_taxable', 'subtotal_nontaxable', 'tax_rate', 'tax_amount', 'total',
    'send_ok_at', 'send_ok_by'];
  k text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' and not new.is_legacy then
      raise exception '請求書は下書きから作ります';
    end if;
    if new.status = 'draft' and new.invoice_no is not null and new.replaces_invoice_id is null then
      raise exception '請求書番号は送付OKのときに自動で付きます';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'draft' and old.invoice_no is null then
      return old;   -- 番号の付いていない下書きだけは消せる
    end if;
    raise exception '請求書は削除できません。取消してください';
  end if;

  -- どの状態でも変えられないもの
  if new.company_id is distinct from old.company_id
     or new.revision is distinct from old.revision
     or new.replaces_invoice_id is distinct from old.replaces_invoice_id
     or new.is_legacy is distinct from old.is_legacy then
    raise exception '請求書の企業・版は変更できません';
  end if;
  if old.invoice_no is not null and new.invoice_no is distinct from old.invoice_no then
    raise exception '請求書番号は変更できません';
  end if;

  if old.status = new.status then
    if old.status = 'draft' then
      if new.invoice_no is distinct from old.invoice_no then
        raise exception '請求書番号は送付OKのときに自動で付きます';
      end if;
      if new.billing_month is distinct from old.billing_month
         and exists (select 1 from public.billing_requests where invoice_id = old.id) then
        raise exception '依頼が載っている請求書の請求月は変えられません。依頼を外してから変えてください';
      end if;
      return new;
    end if;
    -- 送付OKから先は、PDF・メモ・送付日（送付済みのとき）以外は変えない
    foreach k in array frozen loop
      if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
        raise exception '送付OKのあとは請求書の内容を変更できません（%）。送付OKを取り消すか、訂正版を作ってください', k;
      end if;
    end loop;
    if old.status <> 'sent' and new.sent_on is distinct from old.sent_on then
      raise exception '送付日は送付済みにするときに入れます';
    end if;
    return new;
  end if;

  if (old.status, new.status) in (
       ('draft', 'send_ok'), ('draft', 'cancelled'),
       ('send_ok', 'sent'), ('send_ok', 'draft'), ('send_ok', 'cancelled'),
       ('sent', 'superseded'), ('sent', 'cancelled')) then
    if (old.status, new.status) = ('send_ok', 'draft') and new.reopen_reason is null then
      raise exception '送付OKを取り消す理由を入れてください';
    end if;
    if old.status <> 'draft' and new.status not in ('draft') then
      -- 送付OK以降の状態の変化では、固めた内容はそのまま
      foreach k in array frozen loop
        if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
          raise exception '状態を変えるときに請求書の内容は変更できません（%）', k;
        end if;
      end loop;
    end if;
    return new;
  end if;

  raise exception 'この請求書は「%」から「%」にはできません', old.status, new.status;
end;
$$;

create trigger invoices_guard
  before insert or update or delete on public.invoices
  for each row execute function public.guard_invoices();

-- 請求書の明細は、下書きのあいだ（＝送付OKの処理の中）にだけ写せる。書き換えはしない
create or replace function public.guard_invoice_lines()
returns trigger
language plpgsql
as $$
declare
  st     text;
  legacy boolean;
begin
  if tg_op = 'UPDATE' then
    raise exception '請求書の明細は変更できません';
  end if;
  select status, is_legacy into st, legacy from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if st is distinct from 'draft' and not coalesce(legacy, false) then
    raise exception '送付OKのあとは請求書の明細を変更できません';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger invoice_lines_guard
  before insert or update or delete on public.invoice_lines
  for each row execute function public.guard_invoice_lines();

-- 売上：請求依頼から作られた売上は、取消以外では変えない。取消したものは戻さない
create or replace function public.guard_sales()
returns trigger
language plpgsql
as $$
declare
  st     text;
  legacy boolean;
begin
  if tg_op = 'INSERT' then
    if new.invoice_id is not null then
      select status, is_legacy into st, legacy from public.invoices where id = new.invoice_id;
      if st is distinct from 'draft' and not coalesce(legacy, false) then
        raise exception '請求書の売上は、送付OKのときに作られます';
      end if;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception '売上は削除できません。取消してください';
  end if;
  if old.status = 'cancelled' then
    raise exception '取消した売上は変更できません';
  end if;
  if old.billing_request_id is not null or old.invoice_id is not null then
    if (to_jsonb(new) - array['status', 'cancel_reason', 'note', 'version', 'updated_at', 'updated_by'])
       is distinct from (to_jsonb(old) - array['status', 'cancel_reason', 'note', 'version', 'updated_at', 'updated_by']) then
      raise exception '請求依頼から作られた売上は変更できません。取消して作り直してください';
    end if;
  end if;
  return new;
end;
$$;

create trigger sales_guard
  before insert or update or delete on public.sales
  for each row execute function public.guard_sales();

-- 入金の割り当て：有効な（送付OK・送付済みの）請求書と、有効な売上にだけ
create or replace function public.guard_allocations()
returns trigger
language plpgsql
as $$
begin
  if new.invoice_id is not null and not exists (
       select 1 from public.invoices where id = new.invoice_id and (status in ('send_ok', 'sent') or is_legacy)) then
    raise exception '入金は、送付OK・送付済みの請求書にだけ割り当てられます';
  end if;
  if new.sale_id is not null and not exists (
       select 1 from public.sales where id = new.sale_id and status = 'active' and invoice_id is null) then
    raise exception '入金は、請求書のない有効な売上にだけ直接割り当てられます';
  end if;
  return new;
end;
$$;

create trigger receipt_allocations_guard
  before insert or update on public.receipt_allocations
  for each row execute function public.guard_allocations();

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
-- 請求まわりの共通処理（画面からはこの関数を呼ぶ）
--   どれも、同じ操作を2回押しても結果は1回分（2回目は今の状態を返すだけ）
-- ---------------------------------------------------------------------

-- 下書きの請求書を作り、請求依頼を載せる
create or replace function public.invoice_create_draft(p_company_id uuid, p_billing_month date, p_request_ids uuid[])
returns public.invoices
language plpgsql
as $$
declare
  co  public.companies;
  inv public.invoices;
begin
  select * into co from public.companies where id = p_company_id;
  if co.id is null then
    raise exception '企業が見つかりません';
  end if;
  insert into public.invoices (company_id, billing_month, send_method, send_to_email)
  values (p_company_id, p_billing_month, co.send_method, co.email)
  returning * into inv;
  if p_request_ids is not null and cardinality(p_request_ids) > 0 then
    update public.billing_requests set invoice_id = inv.id where id = any(p_request_ids);
  end if;
  return inv;
end;
$$;

-- 確認用の「指紋」。画面で見せた内容と、送付OKを押した瞬間の内容が同じかを確かめる
create or replace function public.invoice_fingerprint(p_invoice_id uuid)
returns text
language sql
stable
as $$
  select md5(jsonb_build_object(
    'invoice', (select jsonb_build_object(
                  'company', i.company_id, 'month', i.billing_month, 'issue', i.issue_date,
                  'due', i.payment_due_date, 'send', i.send_method, 'email', i.send_to_email)
                from public.invoices i where i.id = p_invoice_id),
    'company', (select jsonb_build_object(
                  'name', c.name, 'honorific', c.honorific, 'postal', c.postal_code,
                  'address1', c.address1, 'address2', c.address2, 'department', c.department,
                  'contact', c.contact_name, 'due_m', c.payment_due_months, 'due_d', c.payment_due_day)
                from public.invoices i join public.companies c on c.id = i.company_id
                where i.id = p_invoice_id),
    'tax', jsonb_build_object('rate', public.setting_text('tax_rate', '0.10'),
                              'rounding', public.setting_text('tax_rounding', 'ceil')),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'v', r.version) order by r.id), '[]')
                   from public.billing_requests r where r.invoice_id = p_invoice_id),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                       'r', l.request_id, 's', l.sort, 'd', l.description, 'q', l.quantity,
                       'p', l.unit_price, 'a', l.amount, 't', l.taxable) order by l.request_id, l.sort, l.id), '[]')
                from public.billing_requests r join public.billing_request_lines l on l.request_id = r.id
               where r.invoice_id = p_invoice_id)
  )::text)
$$;

-- 入金予定日の初期値（企業の設定：請求月の◯か月後の◯日。日が空なら月末）
create or replace function public.default_due_date(p_company_id uuid, p_billing_month date)
returns date
language sql
stable
as $$
  select case
           when c.payment_due_day is null
             then public.month_end((p_billing_month + make_interval(months => c.payment_due_months))::date)
           else least(
             ((p_billing_month + make_interval(months => c.payment_due_months))::date + (c.payment_due_day - 1)),
             public.month_end((p_billing_month + make_interval(months => c.payment_due_months))::date))
         end
    from public.companies c where c.id = p_company_id
$$;

-- 送付OK：内容を固定し、番号を付け、売上を作る
--   p_fingerprint：画面で確認したときの invoice_fingerprint。違えば止めて、再確認してもらう
create or replace function public.invoice_send_ok(p_invoice_id uuid, p_fingerprint text)
returns public.invoices
language plpgsql
as $$
declare
  inv     public.invoices;
  old_inv public.invoices;
  co      public.companies;
  r       public.billing_requests;
  sale_id uuid;
  n_req   integer := 0;
  tx      integer;
  nt      integer;
  rate    numeric := public.setting_text('tax_rate', '0.10')::numeric;
  rmode   text    := public.setting_text('tax_rounding', 'ceil');
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null then
    raise exception '請求書が見つかりません';
  end if;
  if inv.status in ('send_ok', 'sent') then
    return inv;   -- もう送付OK。2回目は何もしない
  end if;
  if inv.status <> 'draft' then
    raise exception 'この請求書は送付OKにできません（状態：%）', inv.status;
  end if;
  if p_fingerprint is distinct from public.invoice_fingerprint(p_invoice_id) then
    raise exception '確認したあとに請求内容が変わっています。画面を読み込み直して、もう一度確認してください';
  end if;

  select * into co from public.companies where id = inv.company_id;

  -- 訂正版なら、前の版を「訂正済み（旧版）」にして、その売上を取消す
  if inv.replaces_invoice_id is not null then
    select * into old_inv from public.invoices where id = inv.replaces_invoice_id for update;
    if old_inv.status = 'sent' then
      update public.invoices set status = 'superseded' where id = old_inv.id;
      update public.sales set status = 'cancelled', cancel_reason = '訂正版 ' || inv.invoice_no || '（第' || inv.revision || '版）に差し替え'
       where invoice_id = old_inv.id and status = 'active';
    elsif old_inv.status <> 'superseded' then
      -- superseded なら、この訂正版の送付OKを一度取り消して直したところ（前の版はもう差し替え済み）
      raise exception '前の版が送付済みではありません（状態：%）', old_inv.status;
    end if;
  end if;

  -- 依頼ごとに売上を作り、明細を写す
  for r in select * from public.billing_requests where invoice_id = p_invoice_id order by created_at, id for update loop
    n_req := n_req + 1;
    if r.status <> 'active' or not r.needs_invoice
       or r.company_id <> inv.company_id or r.billing_month <> inv.billing_month then
      raise exception 'この請求書には載せられない依頼が入っています（企業・請求月・状態を確かめてください）';
    end if;
    if not exists (select 1 from public.billing_request_lines where request_id = r.id) then
      raise exception '明細のない依頼があります';
    end if;
    if exists (select 1 from public.sales where billing_request_id = r.id and status = 'active') then
      raise exception 'すでに売上になっている依頼があります（二重請求の防止）';
    end if;
    select coalesce(sum(amount) filter (where taxable), 0), coalesce(sum(amount) filter (where not taxable), 0)
      into tx, nt from public.billing_request_lines where request_id = r.id;
    insert into public.sales (company_id, billing_request_id, accounting_month, description,
                              amount_taxable, amount_nontaxable, needs_invoice, invoice_id)
    select r.company_id, r.id, r.billing_month,
           string_agg(l.description, ' / ' order by l.sort, l.id), tx, nt, true, p_invoice_id
      from public.billing_request_lines l where l.request_id = r.id
    returning id into sale_id;
    insert into public.invoice_lines (invoice_id, request_id, sale_id, sort, description, quantity,
                                      unit_price, amount, taxable, contract_amount)
    select p_invoice_id, r.id, sale_id, l.sort, l.description, l.quantity, l.unit_price, l.amount,
           l.taxable, l.contract_amount
      from public.billing_request_lines l where l.request_id = r.id;
  end loop;
  if n_req = 0 then
    raise exception '請求依頼が1件も載っていません';
  end if;

  select coalesce(sum(amount) filter (where taxable), 0), coalesce(sum(amount) filter (where not taxable), 0)
    into tx, nt from public.invoice_lines where invoice_id = p_invoice_id;

  update public.invoices set
    status              = 'send_ok',
    invoice_no          = coalesce(inv.invoice_no, public.next_invoice_no(inv.billing_month)),
    issue_date          = coalesce(inv.issue_date, public.month_end(inv.billing_month)),
    payment_due_date    = coalesce(inv.payment_due_date, public.default_due_date(inv.company_id, inv.billing_month)),
    bill_to_name        = co.name,
    honorific           = co.honorific,
    postal_code         = co.postal_code,
    address1            = co.address1,
    address2            = co.address2,
    department          = co.department,
    contact_name        = co.contact_name,
    subtotal_taxable    = tx,
    subtotal_nontaxable = nt,
    tax_rate            = rate,
    tax_amount          = public.calc_tax(tx, rate, rmode),
    total               = tx + nt + public.calc_tax(tx, rate, rmode),
    pdf_path            = null,
    send_ok_at          = now(),
    send_ok_by          = auth.uid()
  where id = p_invoice_id
  returning * into inv;

  -- 前の版に入っていた入金の割り当ては、新しい版へ移す
  if inv.replaces_invoice_id is not null then
    update public.receipt_allocations set invoice_id = inv.id where invoice_id = inv.replaces_invoice_id;
  end if;

  return inv;
end;
$$;

-- 送付OKの取り消し（送る前に直したいとき）。番号はそのまま。直したら、もう一度送付OKが必要
create or replace function public.invoice_reopen(p_invoice_id uuid, p_reason text)
returns public.invoices
language plpgsql
as $$
declare
  inv public.invoices;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.status = 'draft' then
    return inv;   -- もう下書き
  end if;
  if inv.status = 'sent' then
    raise exception 'もう送付済みです。直すときは訂正版を作ってください';
  end if;
  if inv.status <> 'send_ok' then
    raise exception 'この請求書は送付OKを取り消せません（状態：%）', inv.status;
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '送付OKを取り消す理由を入れてください';
  end if;
  if exists (select 1 from public.receipt_allocations where invoice_id = p_invoice_id) then
    raise exception '入金が割り当てられています。先に割り当てを外してください';
  end if;

  update public.invoices set
    status = 'draft', reopened_at = now(), reopened_by = auth.uid(), reopen_reason = p_reason,
    bill_to_name = null, honorific = null, postal_code = null, address1 = null, address2 = null,
    department = null, contact_name = null, subtotal_taxable = null, subtotal_nontaxable = null,
    tax_rate = null, tax_amount = null, total = null, pdf_path = null, send_ok_at = null, send_ok_by = null
  where id = p_invoice_id
  returning * into inv;
  update public.sales set status = 'cancelled', cancel_reason = '送付OKの取り消し：' || p_reason
   where invoice_id = p_invoice_id and status = 'active';
  delete from public.invoice_lines where invoice_id = p_invoice_id;
  return inv;
end;
$$;

-- 送付済みにする（郵送した／メールで送った）
create or replace function public.invoice_mark_sent(p_invoice_id uuid, p_sent_on date default current_date)
returns public.invoices
language plpgsql
as $$
declare
  inv public.invoices;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.status = 'sent' then
    return inv;   -- もう送付済み
  end if;
  if inv.status <> 'send_ok' then
    raise exception '送付OKになっていない請求書は送付済みにできません（状態：%）', inv.status;
  end if;
  update public.invoices set status = 'sent', sent_on = coalesce(p_sent_on, current_date),
         sent_at = now(), sent_by = auth.uid()
   where id = p_invoice_id
  returning * into inv;
  return inv;
end;
$$;

-- 訂正版を作る（送付済みのあとで直したいとき）。同じ番号の次の版を下書きで作り、依頼を移す
create or replace function public.invoice_start_correction(p_invoice_id uuid, p_reason text)
returns public.invoices
language plpgsql
as $$
declare
  old_inv public.invoices;
  inv     public.invoices;
begin
  select * into old_inv from public.invoices where id = p_invoice_id for update;
  if old_inv.status <> 'sent' then
    raise exception '訂正版は送付済みの請求書から作ります（状態：%）。送付前なら送付OKを取り消して直してください', old_inv.status;
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '訂正の理由を入れてください';
  end if;
  select * into inv from public.invoices where replaces_invoice_id = p_invoice_id and status <> 'cancelled';
  if inv.id is not null then
    return inv;   -- 作りかけの訂正版がもうある
  end if;
  if not exists (select 1 from public.billing_requests where invoice_id = p_invoice_id) then
    raise exception 'この請求書には請求依頼がないため、訂正版を作れません';
  end if;
  insert into public.invoices (company_id, billing_month, invoice_no, revision, replaces_invoice_id,
                               correction_reason, issue_date, payment_due_date, send_method, send_to_email, note)
  -- 版は、その番号でこれまでに作った版の次（やめた訂正版も版として数える）
  values (old_inv.company_id, old_inv.billing_month, old_inv.invoice_no,
          (select max(revision) + 1 from public.invoices where invoice_no = old_inv.invoice_no and not is_legacy),
          old_inv.id,
          p_reason, old_inv.issue_date, old_inv.payment_due_date, old_inv.send_method, old_inv.send_to_email, old_inv.note)
  returning * into inv;
  update public.billing_requests set invoice_id = inv.id where invoice_id = old_inv.id;
  return inv;
end;
$$;

-- 請求書の取消
--   ・作りかけの訂正版：中身を前の版に戻し、依頼を前の版へ戻す（前の版は送付済みのまま）
--   ・それ以外：売上を取消し、依頼を請求書から外す（依頼は下書きに戻る）
create or replace function public.invoice_cancel(p_invoice_id uuid, p_reason text)
returns public.invoices
language plpgsql
as $$
declare
  inv public.invoices;
  r   record;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.status = 'cancelled' then
    return inv;
  end if;
  if inv.status = 'superseded' then
    raise exception '訂正済み（旧版）の請求書は取消せません。いまの版を取消してください';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '取消の理由を入れてください';
  end if;
  if exists (select 1 from public.receipt_allocations where invoice_id = p_invoice_id) then
    raise exception '入金が割り当てられています。先に割り当てを外してください';
  end if;

  if inv.replaces_invoice_id is not null and inv.status = 'draft'
     and exists (select 1 from public.invoices where id = inv.replaces_invoice_id and status = 'sent') then
    -- 作りかけの訂正版をやめる：依頼の明細を、前の版に写した内容へ戻す
    for r in select q.id from public.billing_requests q
              where q.invoice_id = p_invoice_id
                and exists (select 1 from public.invoice_lines l
                             where l.invoice_id = inv.replaces_invoice_id and l.request_id = q.id) loop
      delete from public.billing_request_lines where request_id = r.id;
      insert into public.billing_request_lines (request_id, sort, description, quantity, unit_price,
                                                amount, taxable, contract_amount)
      select request_id, sort, description, quantity, unit_price, amount, taxable, contract_amount
        from public.invoice_lines where invoice_id = inv.replaces_invoice_id and request_id = r.id;
    end loop;
    update public.invoices set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
           cancel_reason = p_reason where id = p_invoice_id returning * into inv;
    -- 前の版に載っていた依頼は前の版へ戻し、訂正版で足した依頼は請求書から外す
    update public.billing_requests q set invoice_id = inv.replaces_invoice_id
     where q.invoice_id = p_invoice_id
       and exists (select 1 from public.invoice_lines l
                    where l.invoice_id = inv.replaces_invoice_id and l.request_id = q.id);
    update public.billing_requests set invoice_id = null where invoice_id = p_invoice_id;
    return inv;
  end if;

  update public.invoices set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = p_reason where id = p_invoice_id returning * into inv;
  update public.sales set status = 'cancelled', cancel_reason = '請求書の取消：' || p_reason
   where invoice_id = p_invoice_id and status = 'active';
  update public.billing_requests set invoice_id = null where invoice_id = p_invoice_id;
  return inv;
end;
$$;

-- 請求書を作らない依頼を売上にする（送付OKは通らない）
create or replace function public.request_record_sale(p_request_id uuid, p_tax_amount integer default 0)
returns public.sales
language plpgsql
as $$
declare
  r public.billing_requests;
  s public.sales;
begin
  select * into r from public.billing_requests where id = p_request_id for update;
  if r.id is null then
    raise exception '請求依頼が見つかりません';
  end if;
  select * into s from public.sales where billing_request_id = p_request_id and status = 'active';
  if s.id is not null then
    return s;   -- もう売上になっている
  end if;
  if r.status <> 'active' then
    raise exception '取消した依頼は売上にできません';
  end if;
  if r.needs_invoice then
    raise exception '請求書を作る依頼は、請求書の送付OKで売上になります';
  end if;
  if not exists (select 1 from public.billing_request_lines where request_id = r.id) then
    raise exception '明細がありません';
  end if;
  insert into public.sales (company_id, billing_request_id, accounting_month, description,
                            amount_taxable, amount_nontaxable, tax_amount, needs_invoice)
  select r.company_id, r.id, r.billing_month, string_agg(l.description, ' / ' order by l.sort, l.id),
         coalesce(sum(l.amount) filter (where l.taxable), 0),
         coalesce(sum(l.amount) filter (where not l.taxable), 0),
         coalesce(p_tax_amount, 0), false
    from public.billing_request_lines l where l.request_id = r.id
  returning * into s;
  return s;
end;
$$;

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
  kind          text not null default 'normal' check (kind in ('normal', 'refund')),  -- refund=顧客への返金（支出）
  payment_month date not null check (public.is_month_start(payment_month)),         -- 支払う月
  invoice_date  date,                 -- 相手の請求書の日付
  due_date      date,                 -- 支払期限
  via_soumu     boolean not null default true,  -- false=総務を通さない（カード・引落など）
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
  check (status <> 'requested' or (via_soumu and requested_at is not null)),
  check (status <> 'paid' or ((not via_soumu or requested_at is not null) and paid_on is not null))
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
-- 見るための集計（取消・旧版は自動で外す）
-- ---------------------------------------------------------------------

-- 請求書ごとの入金済み額と残り（送付OK・送付済みだけ）
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
where i.status in ('send_ok', 'sent') or (i.is_legacy and i.status <> 'cancelled')
group by i.id;

-- 送付待ち（送付OKで、まだ送っていないもの）。郵送は南條さん、メールはセレッジ担当
create view public.invoices_to_send
with (security_invoker = true) as
select i.id, i.company_id, i.invoice_no, i.revision, i.billing_month, i.issue_date, i.total,
       i.send_method, i.send_to_email, i.bill_to_name, i.postal_code, i.address1, i.address2,
       i.department, i.contact_name, i.pdf_path, i.send_ok_at, i.send_ok_by
  from public.invoices i
 where i.status = 'send_ok';

-- 契約ごと・対象月ごとの請求状況（手入力しない。毎回ここで判定する）
--   invoiced    ：請求済み（請求書番号つき。請求書のない売上も含む）
--   correcting  ：請求済みで、いま訂正版を作っている
--   draft       ：下書き（依頼はあるが、まだ送付OKになっていない）
--   legacy      ：Excelで請求済み
--   out_of_scope：対象外（契約期間の外、終了した契約のあとの月）
--   unbilled    ：未請求
create or replace function public.contract_billing_status(p_from date, p_to date)
returns table (
  contract_id   uuid,
  company_id    uuid,
  service_month date,
  state         text,
  invoice_no    text,
  request_id    uuid
)
language sql
stable
as $$
  with months as (
    select generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month')::date as m
  ),
  req as (
    select distinct on (r.contract_id, coalesce(r.service_month, r.billing_month))
           r.contract_id, coalesce(r.service_month, r.billing_month) as m, r.id, r.invoice_id
      from public.billing_requests r
     where r.contract_id is not null and r.kind = 'normal' and r.status = 'active'
     order by r.contract_id, coalesce(r.service_month, r.billing_month), r.created_at desc
  )
  select c.id, c.company_id, mo.m,
         case
           when s.id is not null and ci.status = 'draft' and ci.replaces_invoice_id is not null then 'correcting'
           when s.id is not null then 'invoiced'
           when req.id is not null then 'draft'
           when c.legacy_last_service_month is not null and mo.m <= c.legacy_last_service_month then 'legacy'
           when (c.start_month is not null and mo.m < c.start_month)
             or (c.end_month is not null and mo.m > c.end_month)
             or (c.status = 'ended' and (c.legacy_last_service_month is null or mo.m > c.legacy_last_service_month))
             then 'out_of_scope'
           else 'unbilled'
         end,
         coalesce(si.invoice_no, ci.invoice_no),
         req.id
    from public.contracts c
   cross join months mo
    left join req on req.contract_id = c.id and req.m = mo.m
    left join public.sales s on s.billing_request_id = req.id and s.status = 'active'
    left join public.invoices si on si.id = s.invoice_id
    left join public.invoices ci on ci.id = req.invoice_id
$$;

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
--   ・ログインした利用者（admin・viewer）は見られる
--   ・入力・変更は admin だけ（根元・南條さん・セレッジ担当の3人とも admin）
--   ・送付OKを押せる人を絞るかは、セレッジ新担当者との打ち合わせ後に決める
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
