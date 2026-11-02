-- =====================================================================
-- 請求書を作り直す（11/02）
--   請求書作成済み・請求済みの請求を、理由を書いて「入力中」に戻す。番号はそのまま
--   戻す前の中身（請求・明細・金額）は bill_revisions に残す（前の版）
--   直したら、もう一度「請求書を作る」で同じ番号の請求書になる。見た目は普通の請求書（「再発行」などは入れない。ひろみ決定）
--   0007 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない
--   （表を1つ足し、関数と決まりを入れ替えるだけ）
-- =====================================================================

create table if not exists public.bill_revisions (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references public.bills(id),
  revision    integer not null,                 -- 1 = 最初に作った請求書、2 = 1回目の作り直しで作った請求書 …
  reason      text not null check (length(trim(reason)) > 0),
  snapshot    jsonb not null,                   -- 作り直す前の請求と明細（そのときの金額・宛名・送った日も）
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (bill_id, revision)
);
comment on table public.bill_revisions is '作り直す前の請求書（前の版）。消さない・直さない';

alter table public.bill_revisions enable row level security;
drop policy if exists bill_revisions_select on public.bill_revisions;
create policy bill_revisions_select on public.bill_revisions for select to authenticated using (public.is_member());
-- 書き込みは bill_reopen の中だけ：鍵（app.bill_unlock）を開けた処理からの insert だけ通す。update・delete は決まりがないのでできない
drop policy if exists bill_revisions_insert on public.bill_revisions;
create policy bill_revisions_insert on public.bill_revisions for insert to authenticated
  with check (public.is_admin() and public.bill_is_unlocked());

-- 入力中でも、番号の付いた請求（作り直し中）は消せない・企業を変えられない。番号は鍵を開けた処理だけが変える
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
    if old.status = 'draft' and old.invoice_no is null then
      return old;
    end if;
    if old.status = 'draft' then
      raise exception '作り直し中の請求は消せません（請求書の番号が使われています）';
    end if;
    raise exception '請求書を作った請求は消せません';
  end if;
  if new.company_id is distinct from old.company_id and (old.status <> 'draft' or old.invoice_no is not null) then
    raise exception '請求書を作ったあとは企業を変えられません';
  end if;
  if old.status <> 'draft' and not public.bill_is_unlocked() then
    raise exception '請求書を作ったあとは、ここでは直せません。「作り直す」から直してください';
  end if;
  if old.status = 'draft' and new.status <> 'draft' and not public.bill_is_unlocked() then
    raise exception '請求書は「請求書を作る」ボタンから作ります';
  end if;
  if new.invoice_no is distinct from old.invoice_no and not public.bill_is_unlocked() then
    raise exception '請求書の番号は直接は変えられません';
  end if;
  return new;
end;
$$;

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


-- 「作り直す」：理由を書いて入力中に戻す。前の版は bill_revisions に残る。番号はそのまま
create or replace function public.bill_reopen(p_id uuid, p_reason text)
returns public.bills
language plpgsql
as $$
declare
  b   public.bills;
  rev integer;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '作り直す理由を入れてください';
  end if;
  select * into b from public.bills where id = p_id for update;
  if b.id is null then
    raise exception 'この請求は見つかりません（消された可能性があります）';
  end if;
  if b.status = 'draft' then
    return b;   -- もう入力中（作り直し中）。2回目は何もしない
  end if;

  select coalesce(max(revision), 0) + 1 into rev from public.bill_revisions where bill_id = p_id;
  perform set_config('app.bill_unlock', 'on', true);   -- 前の版を残す insert と、請求を戻す update の両方に要る
  insert into public.bill_revisions (bill_id, revision, reason, snapshot)
  values (p_id, rev, trim(p_reason), jsonb_build_object(
    'bill', to_jsonb(b),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.sort, l.id) from public.bill_lines l where l.bill_id = p_id), '[]'::jsonb)
  ));

  update public.bills set
    status = 'draft',
    issued_at = null, issued_by = null,
    sent_on = null, sent_at = null, sent_by = null,
    bill_to_name = null, honorific = null,
    subtotal_taxable = null, subtotal_nontaxable = null, tax_rate = null, tax_amount = null, total = null
  where id = p_id
  returning * into b;
  perform set_config('app.bill_unlock', '', true);
  return b;
end;
$$;

grant execute on function public.bill_reopen(uuid, text) to authenticated;
