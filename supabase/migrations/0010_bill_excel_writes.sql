-- =====================================================================
-- Excelへの記入：どの請求を、どのブックに書いたか（11/03）
--   書き込みはブラウザの中で行い、Excelファイルはサーバーに送らない。ここには「書いた」という記録だけを残す
--   請求ごと・ブックごとに1回だけ（二重に書かない・書き忘れない。decisions.md「フォームとExcelの対応」）
--   book：sales = 売上表、ledger = 収支一覧、company = 企業シート
--   0009 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない（表を1つ足すだけ）
-- =====================================================================

create table if not exists public.bill_excel_writes (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references public.bills(id),
  book        text not null check (book in ('sales', 'ledger', 'company')),
  sheet       text not null,                 -- 書いたシート（例：11月、売上（NEW））
  first_row   integer not null check (first_row > 0),
  last_row    integer not null check (last_row >= first_row),
  file_name   text,                          -- 渡されたファイルの名前（どのファイルに書いたかの目印）
  invoice_no  text,                          -- 書いたときの請求書番号
  total       integer,                       -- 書いたときの請求書の合計（税込）
  written_at  timestamptz not null default now(),
  written_by  uuid default auth.uid(),
  unique (bill_id, book)
);
comment on table public.bill_excel_writes is 'Excelへの記入の記録。請求ごと・ブックごとに1行。書いたものを取り消すと消える';

alter table public.bill_excel_writes enable row level security;
drop policy if exists bill_excel_writes_select on public.bill_excel_writes;
create policy bill_excel_writes_select on public.bill_excel_writes for select to authenticated using (public.is_member());
drop policy if exists bill_excel_writes_insert on public.bill_excel_writes;
create policy bill_excel_writes_insert on public.bill_excel_writes for insert to authenticated with check (public.is_admin());
drop policy if exists bill_excel_writes_delete on public.bill_excel_writes;
create policy bill_excel_writes_delete on public.bill_excel_writes for delete to authenticated using (public.is_admin());
-- update の決まりはない（直さない。書き直すときは取り消してから、もう一度書く）

-- 書いた記録を残す。p_items = [{bill_id, issued_at, sheet, first_row, last_row}, …]。1件でも書けないものがあれば、どれも残さない
--   issued_at は、画面で書く行を作ったときの「請求書を作った日時」。そのあとに作り直されていたら記録しない（古い中身をExcelに書いたことになるため）
create or replace function public.bill_excel_mark(p_book text, p_file_name text, p_items jsonb)
returns integer
language plpgsql
as $$
declare
  it    jsonb;
  b     public.bills;
  n     integer := 0;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  if p_book not in ('sales', 'ledger', 'company') then
    raise exception 'ブックの種類が正しくありません';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '記録する請求がありません';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into b from public.bills where id = (it->>'bill_id')::uuid for update;
    if b.id is null then
      raise exception 'この請求は見つかりません（消された可能性があります）';
    end if;
    if b.status not in ('issued', 'sent') then
      raise exception '請求書を作る前の請求は、Excelに書けません（%）', coalesce(b.invoice_no, '番号なし');
    end if;
    if (it->>'issued_at') is null or (it->>'issued_at')::timestamptz is distinct from b.issued_at then
      raise exception '画面を開いたあとに、この請求（%）の請求書が作り直されています。画面を読み込み直して、ファイルを選び直してください', b.invoice_no
        using errcode = '40001';
    end if;
    if exists (select 1 from public.bill_excel_writes where bill_id = b.id and book = p_book) then
      raise exception 'この請求（%）は、もうこのExcelに書いてあります', b.invoice_no;
    end if;
    insert into public.bill_excel_writes (bill_id, book, sheet, first_row, last_row, file_name, invoice_no, total)
    values (b.id, p_book, it->>'sheet', (it->>'first_row')::integer, (it->>'last_row')::integer,
            nullif(trim(coalesce(p_file_name, '')), ''), b.invoice_no, b.total);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 書いた記録を取り消す（ファイルを保存しなかった・書いた行を手で消した、など）。もう一度書けるようになる
create or replace function public.bill_excel_unmark(p_bill_id uuid, p_book text)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  delete from public.bill_excel_writes where bill_id = p_bill_id and book = p_book;
  get diagnostics n = row_count;
  return n;
end;
$$;
