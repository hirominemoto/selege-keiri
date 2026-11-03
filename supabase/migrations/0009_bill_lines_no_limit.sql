-- =====================================================================
-- 請求書の明細は何行でも作れるようにする（11/03）
--   請求書は1社1枚が基本。8行を超えたら、請求書の行を詰めて A4 1枚に収める（画面と印刷で詰める）
--   別の請求書に分けることはしない。何十行もあるようなときはイレギュラーなので、そのつど相談する
--   0008 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない
--   （bill_issue から「8行まで」の確かめを外すだけ。ほかは 0008 と同じ）
-- =====================================================================

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
  -- 明細の行の数は決めない。9行以上は請求書の行を詰めて1枚に収める（1社1枚。11/03 ひろみ決定）

  select * into co from public.companies where id = b.company_id;
  select coalesce(sum(amount) filter (where taxable), 0), coalesce(sum(amount) filter (where not taxable), 0)
    into tx, nt from public.bill_lines where bill_id = p_id;
  tax := public.calc_tax(tx, rate, rmode);

  perform set_config('app.bill_unlock', 'on', true);
  update public.bills set
    status              = 'issued',
    invoice_no          = coalesce(b.invoice_no, public.bill_next_invoice_no(b.accounting_month)),  -- 作り直しなら番号はそのまま
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
