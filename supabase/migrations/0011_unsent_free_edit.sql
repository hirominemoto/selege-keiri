-- =====================================================================
-- 送る前の請求書は、自由に直せて消せる（11/04 ひろみ決定）
--   線を引くのは「請求書を作る」ではなく「送った」
--   請求書作成済み（まだ送っていない）：「作り直す」に理由はいらない。「消す」もできる（番号は飛ぶ。ひろみOK）
--   請求済み（送った。前に一度でも送ったものも）：作り直すには理由が要る。消せない
--   Excel（売上表・収支一覧）に記入済みの請求は消せない。先に「記入を取り消す」
--   0010 のあとに実行する。何度実行しても同じ結果になる。今あるデータは消さない・変えない
--   （関数と決まりを入れ替え、前の版を消す決まりを1つ足すだけ）
-- =====================================================================

-- 一度でも送ったか（いま請求済み、または前の版のどれかが請求済み）
create or replace function public.bill_ever_sent(b public.bills)
returns boolean
language sql
stable
as $$
  select b.status = 'sent'
      or exists (select 1 from public.bill_revisions r
                 where r.bill_id = b.id and r.snapshot->'bill'->>'status' = 'sent')
$$;

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
    -- 送る前の請求書は bill_delete_draft（鍵を開けた処理）からだけ消せる。送ったかどうかはそこで確かめる
    if public.bill_is_unlocked() then
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

-- 前の版は、送る前の請求書を消すとき（鍵を開けた処理）だけ消せる
drop policy if exists bill_revisions_delete on public.bill_revisions;
create policy bill_revisions_delete on public.bill_revisions for delete to authenticated
  using (public.is_admin() and public.bill_is_unlocked());

-- 請求を消す：入力中、または請求書を作ったがまだ送っていないもの
create or replace function public.bill_delete_draft(p_id uuid)
returns void
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
    return;   -- もう消えている
  end if;
  if b.status = 'draft' and b.invoice_no is null then
    delete from public.bills where id = p_id;
    return;
  end if;
  if public.bill_ever_sent(b) then
    raise exception '送った請求書は消せません。直すときは「作り直す」から直してください';
  end if;
  if exists (select 1 from public.bill_excel_writes w where w.bill_id = p_id) then
    raise exception 'Excelに記入済みの請求は消せません。先に「Excelへの記入」で記入を取り消し、Excelの行も消してください';
  end if;
  perform set_config('app.bill_unlock', 'on', true);
  delete from public.bill_revisions where bill_id = p_id;
  delete from public.bills where id = p_id;   -- 明細も一緒に消える
  perform set_config('app.bill_unlock', '', true);
end;
$$;

-- 「作り直す」：送る前なら理由はいらない。ほかは 0008 と同じ
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
  select * into b from public.bills where id = p_id for update;
  if b.id is null then
    raise exception 'この請求は見つかりません（消された可能性があります）';
  end if;
  if b.status = 'draft' then
    return b;   -- もう入力中（作り直し中）。2回目は何もしない
  end if;
  -- 理由が要るのは、送ったあとだけ（相手の手元に前の請求書があるため）。送る前は書かなくてよい
  if coalesce(trim(p_reason), '') = '' then
    if public.bill_ever_sent(b) then
      raise exception '送ったあとの請求書を作り直すときは、理由を入れてください';
    end if;
    p_reason := '送る前の直し';
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
