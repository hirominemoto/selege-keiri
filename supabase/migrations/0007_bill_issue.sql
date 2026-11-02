-- =====================================================================
-- 請求書を作る・送った（手順4。11/02）
--   「請求書を作る」：番号を付け、その時の金額と宛名を請求に書き残す（あとで設定が変わっても請求書は変わらない）
--   「送った」：送った日と送り方を残して、請求済みにする
--   0006 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない
--   （列を足し、関数を足すだけ。足す列は最初は空）
-- =====================================================================

-- 請求書を作ったときに固まる中身（入力中のあいだは空のまま）
alter table public.bills add column if not exists bill_to_name        text;     -- 宛名（その時の企業名）
alter table public.bills add column if not exists honorific           text;     -- 御中／様
alter table public.bills add column if not exists subtotal_taxable    integer;  -- 10％対象（小計）
alter table public.bills add column if not exists subtotal_nontaxable integer;  -- 対象外
alter table public.bills add column if not exists tax_rate            numeric(4, 3);
alter table public.bills add column if not exists tax_amount          integer;  -- 消費税
alter table public.bills add column if not exists total               integer;  -- 合計（税込）

-- 請求書番号：「年度2桁＋月2桁-その月の連番」（2026年11月の1枚目は 2711-01）。月は計上月
--   お試し版（invoices）の番号とは別に、この表の中だけで数える
create or replace function public.bill_next_invoice_no(p_month date)
returns text
language plpgsql
as $$
declare
  p   text := public.invoice_no_prefix(date_trunc('month', p_month)::date);
  seq integer;
begin
  -- 同時に2人が押しても同じ番号にならないよう、番号を決めるあいだは順番待ちにする
  perform pg_advisory_xact_lock(hashtext('bill_invoice_no:' || p));
  select coalesce(max(split_part(invoice_no, '-', 2)::integer), 0) + 1 into seq
    from public.bills
   where invoice_no like p || '-%' and split_part(invoice_no, '-', 2) ~ '^\d+$';
  return p || '-' || lpad(seq::text, greatest(2, length(seq::text)), '0');
end;
$$;

-- 「請求書を作る」。二度押しても番号も請求書も1つだけ
create or replace function public.bill_issue(p_id uuid, p_version integer)
returns public.bills
language plpgsql
as $$
declare
  b     public.bills;
  co    public.companies;
  tx    integer;
  nt    integer;
  rate  numeric := public.setting_text('tax_rate', '0.10')::numeric;
  rmode text    := public.setting_text('tax_rounding', 'ceil');
  tax   integer;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  select * into b from public.bills where id = p_id for update;
  if b.id is null then
    raise exception 'この請求は見つかりません（消された可能性があります）';
  end if;
  if b.status in ('issued', 'sent') then
    return b;   -- もう請求書を作ってある。2回目は何もしない
  end if;
  if p_version is distinct from b.version then
    raise exception '画面を開いたあとに、この請求が直されています。画面を読み込み直してから、もう一度押してください'
      using errcode = '40001';
  end if;
  if not exists (select 1 from public.bill_lines where bill_id = p_id) then
    raise exception '明細がありません';
  end if;
  -- 請求書は A4 1枚・明細8行（今のExcelと同じ）。9行以上は印刷で切れるので作らない
  if (select count(*) from public.bill_lines where bill_id = p_id) > 8 then
    raise exception '請求書の明細は8行までです。9行目からは別の請求に分けてください';
  end if;

  select * into co from public.companies where id = b.company_id;
  select coalesce(sum(amount) filter (where taxable), 0), coalesce(sum(amount) filter (where not taxable), 0)
    into tx, nt from public.bill_lines where bill_id = p_id;
  tax := public.calc_tax(tx, rate, rmode);

  perform set_config('app.bill_unlock', 'on', true);
  update public.bills set
    status              = 'issued',
    invoice_no          = public.bill_next_invoice_no(b.accounting_month),
    issued_at           = now(),
    issued_by           = auth.uid(),
    bill_to_name        = co.name,
    honorific           = co.honorific,
    subtotal_taxable    = tx,
    subtotal_nontaxable = nt,
    tax_rate            = rate,
    tax_amount          = tax,
    total               = tx + nt + tax
  where id = p_id
  returning * into b;
  perform set_config('app.bill_unlock', '', true);
  return b;
end;
$$;

-- 「送った」。送った日と送り方を残して請求済みにする。二度押しても1回だけ
create or replace function public.bill_mark_sent(p_id uuid, p_sent_on date, p_send_method text)
returns public.bills
language plpgsql
as $$
declare
  b public.bills;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  select * into b from public.bills where id = p_id for update;
  if b.id is null then
    raise exception 'この請求は見つかりません（消された可能性があります）';
  end if;
  if b.status = 'sent' then
    return b;
  end if;
  if b.status <> 'issued' then
    raise exception '先に「請求書を作る」を押してください';
  end if;
  if p_sent_on is null then
    raise exception '送った日を入れてください';
  end if;
  if p_send_method not in ('post', 'email') then
    raise exception '送り方（郵送／メール）を選んでください';
  end if;

  perform set_config('app.bill_unlock', 'on', true);
  update public.bills set
    status      = 'sent',
    sent_on     = p_sent_on,
    send_method = p_send_method,
    sent_at     = now(),
    sent_by     = auth.uid()
  where id = p_id
  returning * into b;
  perform set_config('app.bill_unlock', '', true);
  return b;
end;
$$;

grant execute on function public.bill_issue(uuid, integer) to authenticated;
grant execute on function public.bill_mark_sent(uuid, date, text) to authenticated;
