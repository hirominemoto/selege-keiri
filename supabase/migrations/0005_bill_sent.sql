-- =====================================================================
-- 請求の状態を3つにする（10/30 ひろみ決定）
--   draft  = アプリに入力済み（まだ直せる）
--   issued = 請求書作成済み（請求書№が付いた）
--   sent   = 請求済み（お客さんに送った。送った日を残す）
--   0004 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない
--   （状態の決まりを広げ、送った日の列を足すだけ）
-- =====================================================================

alter table public.bills add column if not exists sent_on date;           -- 送った日
alter table public.bills add column if not exists sent_at timestamptz;    -- 「送った」を押した日時
alter table public.bills add column if not exists sent_by uuid;           -- 押した人

alter table public.bills drop constraint if exists bills_status_check;
alter table public.bills add constraint bills_status_check check (status in ('draft', 'issued', 'sent'));

alter table public.bills drop constraint if exists bills_sent_check;
alter table public.bills add constraint bills_sent_check check (status <> 'sent' or sent_on is not null);

comment on table public.bills is '請求（1回の入力 = 1枚の請求書）。アプリに入力済み → 請求書作成済み → 請求済み';

-- 請求書作成済み・請求済みのどちらも、ここでは直接は直せない（0003 の決まりを3つの状態に合わせる）
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

