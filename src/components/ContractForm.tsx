"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { saveContract } from "@/app/(app)/companies/actions";
import { ActionForm } from "@/components/ActionForm";
import { Field } from "@/components/Field";
import { DEFAULT_TEMPLATE, monthName, nextCount, renderTemplate } from "@/lib/contract";
import { toMonthInput, yen } from "@/lib/format";
import type { Contract } from "@/lib/types";

type Props = {
  companyId: string;
  companyName: string;
  contract?: Contract;
  maxCountInApp?: number | null; // アプリで請求した最大の回数
  exampleMonth: string; // 例として使う請求月（"2026-11-01"）
};

export function ContractForm({ companyId, companyName, contract, maxCountInApp = null, exampleMonth }: Props) {
  const [state, action, pending] = useActionState(saveContract, {});
  const e = state.errors ?? {};
  const c = contract;

  // 品名の見本に使う値
  const [name, setName] = useState(c?.name ?? "在留サポートサービス");
  const [cohort, setCohort] = useState(c?.cohort ?? "");
  const [quantity, setQuantity] = useState(String(c?.quantity ?? 1));
  const [unitPrice, setUnitPrice] = useState(String(c?.unit_price ?? ""));
  const [offset, setOffset] = useState(String(c?.service_month_offset ?? 0));
  const [totalCount, setTotalCount] = useState(c?.total_count ? String(c.total_count) : "");
  const [baseCount, setBaseCount] = useState(String(c?.base_count ?? 0));
  const [template, setTemplate] = useState(c?.description_template ?? "");

  const num = (s: string) => Number(s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[,，円]/g, ""));
  const q = num(quantity) || 0;
  const count = nextCount(num(baseCount) || 0, maxCountInApp);
  const preview = renderTemplate(template, {
    人数: q,
    契約名: name,
    期: cohort,
    対象月: monthName(exampleMonth, Number(offset)),
    回数: count,
    全回数: totalCount,
  });
  const amount = Math.round(q * (num(unitPrice) || 0));
  const exampleBilling = monthName(exampleMonth, 0);

  return (
    <ActionForm action={action} className="form card">
      <input type="hidden" name="company_id" value={companyId} />
      {c && (
        <>
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="version" value={c.version} />
        </>
      )}

      <div className="form-section">
        <h2>{companyName} の契約</h2>
        <div className="form-row">
          <Field label="契約名" name="name" required error={e.name} hint="例：在留サポートサービス、コンサルタントサポート費">
            <input id="name" name="name" type="text" value={name} onChange={(ev) => setName(ev.target.value)} />
          </Field>
          <Field label="期" name="cohort" error={e.cohort} hint="一期生・二期生など。同じ企業で分けたいときに">
            <input id="cohort" name="cohort" type="text" value={cohort} onChange={(ev) => setCohort(ev.target.value)} />
          </Field>
        </div>
        <Field label="請求のしかた" name="kind" asGroup>
          <div className="choices" role="radiogroup" aria-labelledby="kind-label">
            <label className="choice">
              <input type="radio" name="kind" value="monthly" defaultChecked={(c?.kind ?? "monthly") === "monthly"} />
              毎月
            </label>
            <label className="choice">
              <input type="radio" name="kind" value="one_time" defaultChecked={c?.kind === "one_time"} />
              1回だけ
            </label>
          </div>
        </Field>
      </div>

      <div className="form-section">
        <h2>金額</h2>
        <div className="form-row">
          <Field label="人数・個数" name="quantity" required error={e.quantity}>
            <input
              id="quantity"
              name="quantity"
              type="text"
              inputMode="decimal"
              value={quantity}
              onChange={(ev) => setQuantity(ev.target.value)}
            />
          </Field>
          <Field label="単価（税抜）" name="unit_price" required error={e.unit_price} hint="1人・1個あたりの金額">
            <input
              id="unit_price"
              name="unit_price"
              type="text"
              inputMode="numeric"
              value={unitPrice}
              onChange={(ev) => setUnitPrice(ev.target.value)}
            />
          </Field>
        </div>
        <Field label="消費税" name="taxable" asGroup hint="航空券などの立替金は「かからない」">
          <div className="choices" role="radiogroup" aria-labelledby="taxable-label">
            <label className="choice">
              <input type="radio" name="taxable" value="true" defaultChecked={c?.taxable ?? true} />
              かかる
            </label>
            <label className="choice">
              <input type="radio" name="taxable" value="false" defaultChecked={c ? !c.taxable : false} />
              かからない
            </label>
          </div>
        </Field>
        <p className="small muted" style={{ margin: 0 }}>
          毎月の金額（税抜）：<strong>{yen(amount)}</strong>　※ 人数が変わった月は、請求のときに変更できます
        </p>
      </div>

      <div className="form-section">
        <h2>「◯月分」と回数</h2>
        <Field label="請求月と「◯月分」の関係" name="service_month_offset" asGroup>
          <div className="choices" role="radiogroup" aria-labelledby="service_month_offset-label">
            <label className="choice">
              <input type="radio" name="service_month_offset" value="0" checked={offset === "0"} onChange={() => setOffset("0")} />
              請求月と同じ月分（{exampleBilling}末の請求で{exampleBilling}分）
            </label>
            <label className="choice">
              <input type="radio" name="service_month_offset" value="1" checked={offset === "1"} onChange={() => setOffset("1")} />
              翌月分を前請求（{exampleBilling}末の請求で{monthName(exampleMonth, 1)}分）
            </label>
          </div>
        </Field>
        <div className="form-row">
          <Field label="全回数" name="total_count" error={e.total_count} hint="「全12回」なら 12。決まっていなければ空">
            <input
              id="total_count"
              name="total_count"
              type="text"
              inputMode="numeric"
              value={totalCount}
              onChange={(ev) => setTotalCount(ev.target.value)}
            />
          </Field>
          <Field label="数え方" name="count_unit">
            <select id="count_unit" name="count_unit" defaultValue={c?.count_unit ?? "回"}>
              <option value="回">◯回目</option>
              <option value="か月">◯か月目</option>
            </select>
          </Field>
          <Field
            label="アプリを使う前に請求した回数"
            name="base_count"
            error={e.base_count}
            hint="Excelで「12回目」まで請求済みなら 12"
          >
            <input
              id="base_count"
              name="base_count"
              type="text"
              inputMode="numeric"
              value={baseCount}
              onChange={(ev) => setBaseCount(ev.target.value)}
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="開始月" name="start_month" error={e.start_month}>
            <input id="start_month" name="start_month" type="month" defaultValue={toMonthInput(c?.start_month)} />
          </Field>
          <Field label="終了月" name="end_month" error={e.end_month} hint="決まっていなければ空">
            <input id="end_month" name="end_month" type="month" defaultValue={toMonthInput(c?.end_month)} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h2>請求書の品名</h2>
        <Field
          label="品名のひな形"
          name="description_template"
          hint={
            <>
              空のときは「{DEFAULT_TEMPLATE}」を使います。使える言葉：{"{人数}"} {"{契約名}"} {"{期}"} {"{対象月}"} {"{回数}"}{" "}
              {"{全回数}"}
            </>
          }
        >
          <input
            id="description_template"
            name="description_template"
            type="text"
            value={template}
            placeholder={DEFAULT_TEMPLATE}
            onChange={(ev) => setTemplate(ev.target.value)}
          />
        </Field>
        <div className="notice notice-info">
          次の請求書の品名（{exampleBilling}末に請求する場合）：<br />
          <strong>{preview}</strong>
        </div>
      </div>

      <div className="form-section">
        {c && (
          <Field label="契約の状態" name="status">
            <select id="status" name="status" defaultValue={c.status}>
              <option value="active">継続中</option>
              <option value="paused">休止中</option>
              <option value="ended">終了</option>
            </select>
          </Field>
        )}
        <Field label="メモ" name="note">
          <textarea id="note" name="note" defaultValue={c?.note ?? ""} />
        </Field>
      </div>

      {state.message && <p className="notice notice-error">{state.message}</p>}
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "保存しています…" : c ? "変更を保存" : "登録する"}
        </button>
        <Link href={`/companies/${companyId}`} className="btn btn-secondary">
          やめる
        </Link>
      </div>
    </ActionForm>
  );
}
