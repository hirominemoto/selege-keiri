-- =====================================================================
-- 企業シート（旧Excel・もとの社内申込書）の行を1回だけ取り込む（11/01 ひろみ決定）
--   10/31 までの行は、すべて請求済みとみなす（売上表 10月シートと照合済み）
--   11月からは、アプリで入力した請求が記録の元になる
--   フォームの「請求の履歴」に、この行とアプリの請求を月ごとに並べる
--
--   0001〜0005 のあとに実行する。何度実行しても同じ結果になる
--   今ある表・データは消さない・変えない（新しい表と設定を1つずつ足すだけ）
-- =====================================================================

create table if not exists public.legacy_sheet_rows (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id),
  sheet_name        text not null,                 -- 企業シートのシート名
  row_no            integer not null check (row_no > 0),
  issue_date        date not null,                 -- A 請求日
  accounting_month  date not null check (public.is_month_start(accounting_month)),  -- 請求日の月
  description       text not null,                 -- C 案件名
  unit_price        integer,                       -- D 単価（一時金などは空）
  quantity          numeric(10, 2),                -- E 個数
  amount            integer not null,              -- F 売上金額（税抜）
  note              text,                          -- G 備考
  sheet_month_label text,                          -- H 計上月（手書きの文字。参考に残すだけ）
  payment_due_date  date,                          -- I 支払期限
  imported_at       timestamptz not null default now(),
  imported_by       uuid default auth.uid(),
  unique (sheet_name, row_no)
);

comment on table public.legacy_sheet_rows is '企業シート（旧Excel）から取り込んだ請求の行。フォームの履歴に出すだけで、直さない';

create index if not exists legacy_sheet_rows_company_idx on public.legacy_sheet_rows (company_id, accounting_month desc);

alter table public.legacy_sheet_rows enable row level security;
drop policy if exists legacy_sheet_rows_select on public.legacy_sheet_rows;
drop policy if exists legacy_sheet_rows_insert on public.legacy_sheet_rows;
drop policy if exists legacy_sheet_rows_delete on public.legacy_sheet_rows;
create policy legacy_sheet_rows_select on public.legacy_sheet_rows for select to authenticated using (public.is_member());
create policy legacy_sheet_rows_insert on public.legacy_sheet_rows for insert to authenticated with check (public.is_admin());
create policy legacy_sheet_rows_delete on public.legacy_sheet_rows for delete to authenticated using (public.is_admin());
-- update の決まりは作らない（取り込んだ行は直さない。取り込み直すときは入れ替える）

-- ここまでの請求日の行を「請求済み」とみなす
insert into public.app_settings (key, value, note) values
  ('legacy_billed_until', '"2026-10-31"', '企業シート（旧Excel）の行を、この請求日まで請求済みとみなす（11/01 ひろみ決定）')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 取り込み：今ある取り込み済みの行を、渡された行で入れ替える（1回の処理で全部か、何もしないか）
--   p_rows: [{company_id, sheet_name, row_no, issue_date, description, unit_price, quantity, amount, note, sheet_month_label, payment_due_date}]
--   この表の行だけを入れ替える。企業・契約・請求には触らない
-- ---------------------------------------------------------------------

create or replace function public.legacy_sheet_import(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  n integer;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception '取り込む行がありません';
  end if;

  delete from public.legacy_sheet_rows where true;

  insert into public.legacy_sheet_rows
    (company_id, sheet_name, row_no, issue_date, accounting_month, description,
     unit_price, quantity, amount, note, sheet_month_label, payment_due_date)
  select r.company_id, r.sheet_name, r.row_no, r.issue_date, date_trunc('month', r.issue_date)::date, trim(r.description),
         r.unit_price, r.quantity, r.amount, nullif(trim(r.note), ''), nullif(trim(r.sheet_month_label), ''), r.payment_due_date
  from jsonb_to_recordset(p_rows) as r(
    company_id uuid, sheet_name text, row_no integer, issue_date date, description text,
    unit_price integer, quantity numeric, amount integer, note text, sheet_month_label text, payment_due_date date);

  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.legacy_sheet_import(jsonb) to authenticated;
