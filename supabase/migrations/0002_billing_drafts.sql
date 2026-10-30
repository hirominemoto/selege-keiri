-- =====================================================================
-- 「今月の請求」画面のための処理
--   ・契約を選んで、請求依頼と下書きの請求書をまとめて作る（全部できるか、何もしないか）
--   ・下書きの請求書を、載っている依頼ごと片付ける
-- 0001_init.sql のあとに1回だけ実行する。何度実行しても同じ結果になる
-- =====================================================================

-- 契約から下書きをまとめて作る
--   p_items：[{ "contract_id", "service_month", "count_no", "description", "quantity", "unit_price", "taxable" }, ...]
--     品名・回数の組み立ては画面側（src/lib/contract.ts）で行い、ここでは記録だけする
--   ・同じ契約・同じ「◯月分」の依頼がすでにあれば、作らずに飛ばす（2回押しても1回分）
--   ・企業ごとに1枚の下書きにまとめる。その企業・その月の下書きがすでにあれば、そこに足す
--   返り値：{ "created": 作った依頼の数, "skipped": 飛ばした数, "invoices": [下書きの id, ...] }
create or replace function public.billing_create_drafts(p_billing_month date, p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
  it        jsonb;
  c         public.contracts;
  svc       date;
  req_id    uuid;
  qty       numeric;
  price     integer;
  n_created integer := 0;
  n_skipped integer := 0;
  created   uuid[] := '{}';
  co_id     uuid;
  inv_id    uuid;
  inv_ids   uuid[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  if not public.is_month_start(p_billing_month) then
    raise exception '請求月は月の1日で指定してください';
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into c from public.contracts where id = (it ->> 'contract_id')::uuid;
    if c.id is null then
      raise exception '契約が見つかりません';
    end if;
    svc := coalesce((it ->> 'service_month')::date,
                    (p_billing_month + make_interval(months => c.service_month_offset))::date);

    if exists (select 1 from public.billing_requests r
                where r.contract_id = c.id and r.kind = 'normal' and r.status <> 'cancelled'
                  and coalesce(r.service_month, r.billing_month) = svc) then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    qty   := coalesce((it ->> 'quantity')::numeric, c.quantity);
    price := coalesce((it ->> 'unit_price')::integer, c.unit_price);

    insert into public.billing_requests (company_id, contract_id, kind, billing_month, service_month, count_no, needs_invoice)
    values (c.company_id, c.id, 'normal', p_billing_month, svc, nullif(it ->> 'count_no', '')::integer, true)
    returning id into req_id;

    insert into public.billing_request_lines (request_id, sort, description, quantity, unit_price, amount, taxable, contract_amount)
    values (req_id, 0, coalesce(nullif(trim(it ->> 'description'), ''), c.name), qty, price, round(qty * price)::integer,
            coalesce((it ->> 'taxable')::boolean, c.taxable), round(c.quantity * c.unit_price)::integer);

    created := created || req_id;
    n_created := n_created + 1;
  end loop;

  -- 企業ごとに下書きへまとめる
  for co_id in select distinct r.company_id from public.billing_requests r where r.id = any(created) loop
    select i.id into inv_id
      from public.invoices i
     where i.company_id = co_id and i.billing_month = p_billing_month
       and i.status = 'draft' and i.replaces_invoice_id is null
     order by i.created_at
     limit 1;
    if inv_id is null then
      inv_id := (public.invoice_create_draft(co_id, p_billing_month, null)).id;
    end if;
    update public.billing_requests set invoice_id = inv_id
     where id = any(created) and company_id = co_id;
    inv_ids := inv_ids || inv_id;
    inv_id := null;
  end loop;

  return jsonb_build_object('created', n_created, 'skipped', n_skipped, 'invoices', to_jsonb(inv_ids));
end;
$$;

-- 下書きの請求書を片付ける（番号の付いていない下書きだけ）
--   載っている依頼（と明細）も一緒に消すので、その契約はまた「未請求」に戻る
create or replace function public.invoice_discard_draft(p_invoice_id uuid)
returns void
language plpgsql
as $$
declare
  inv public.invoices;
begin
  if not public.is_admin() then
    raise exception 'この操作は管理者だけができます';
  end if;
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null then
    return;
  end if;
  if inv.status <> 'draft' or inv.invoice_no is not null or inv.replaces_invoice_id is not null then
    raise exception '片付けられるのは、番号の付いていない下書きだけです';
  end if;
  delete from public.billing_requests where invoice_id = p_invoice_id;
  delete from public.invoices where id = p_invoice_id;
end;
$$;
