"use client";

import Link from "next/link";
import { useActionState, useMemo, useRef, useState } from "react";
import { saveBill } from "@/app/(app)/bills/actions";
import { ActionForm } from "@/components/ActionForm";
import { Field } from "@/components/Field";
import { invoiceTotals, type TaxRounding } from "@/lib/billing";
import {
  defaultDueDate,
  lineAmount,
  nextCountFrom,
  readNumber,
  type Bill,
  type BillLine,
  type LineDraft,
} from "@/lib/bills";
import { dateLabel, yen } from "@/lib/format";

export type CompanyOption = {
  id: string;
  name: string;
  send_method: "post" | "email";
  payment_due_months: number;
  payment_due_day: number | null;
};

/** 企業ごとの前回の請求（回数の目安を出すため） */
export type PreviousBill = { issue_date: string; descriptions: string[] };

// 行の key はサーバーとブラウザで同じになるよう、最初の行は決まった名前、足した行は連番にする
const emptyLine = (key: string): LineDraft => ({ key, description: "", unit_price: "", quantity: "1", taxable: true, note: "" });

export function BillForm(props: {
  companies: CompanyOption[];
  previous: Record<string, PreviousBill>;
  taxRate: number;
  taxRounding: TaxRounding;
  defaultStaff: string;
  today: string;
  bill?: Bill;
  lines?: BillLine[];
}) {
  const b = props.bill;
  const [state, action, pending] = useActionState(saveBill, {});
  const e = state.errors ?? {};

  const [companyId, setCompanyId] = useState(b?.company_id ?? "");
  const [issueDate, setIssueDate] = useState(b?.issue_date ?? props.today);
  const [month, setMonth] = useState((b?.accounting_month ?? props.today).slice(0, 7));
  const [monthTouched, setMonthTouched] = useState(!!b);
  const [due, setDue] = useState(b?.payment_due_date ?? "");
  const [dueTouched, setDueTouched] = useState(!!b);
  const [sendMethod, setSendMethod] = useState<"post" | "email">(b?.send_method ?? "post");
  const [sendTouched, setSendTouched] = useState(!!b);
  const [lines, setLines] = useState<LineDraft[]>(
    props.lines && props.lines.length > 0
      ? props.lines.map((l) => ({
          key: l.id,
          description: l.description,
          unit_price: String(l.unit_price),
          quantity: String(Number(l.quantity)),
          taxable: l.taxable,
          note: l.note ?? "",
        }))
      : [emptyLine("first")],
  );
  const added = useRef(0);
  const newLine = () => emptyLine(`added-${++added.current}`);

  const company = props.companies.find((c) => c.id === companyId);
  const prev = companyId ? props.previous[companyId] : undefined;
  const hints = (prev?.descriptions ?? [])
    .map((d) => ({ d, next: nextCountFrom(d) }))
    .filter((h): h is { d: string; next: string } => h.next !== null);

  // 企業・請求日が変わったら、手で直していない項目の初期値を入れ直す
  const recompute = (nextCompanyId: string, nextIssueDate: string) => {
    const c = props.companies.find((x) => x.id === nextCompanyId);
    if (!monthTouched && nextIssueDate) setMonth(nextIssueDate.slice(0, 7));
    if (c && !dueTouched && nextIssueDate) setDue(defaultDueDate(nextIssueDate, c.payment_due_months, c.payment_due_day));
    if (c && !sendTouched) setSendMethod(c.send_method);
  };

  const amounts = lines.map((l) => {
    const p = readNumber(l.unit_price);
    const q = readNumber(l.quantity);
    return p !== null && q !== null ? lineAmount(p, q) : null;
  });
  const totals = useMemo(
    () =>
      invoiceTotals(
        lines.map((l, i) => ({ amount: amounts[i] ?? 0, taxable: l.taxable })),
        props.taxRate,
        props.taxRounding,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, props.taxRate, props.taxRounding],
  );
  const hasNontaxable = lines.some((l) => !l.taxable && (readNumber(l.unit_price) ?? 0) !== 0);

  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => setLines((ls) => (ls.length === 1 ? [newLine()] : ls.filter((l) => l.key !== key)));
  const move = (i: number, d: -1 | 1) =>
    setLines((ls) => {
      const j = i + d;
      if (j < 0 || j >= ls.length) return ls;
      const copy = [...ls];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const lineErrors = Object.entries(e).filter(([k]) => k.startsWith("line-") || k === "lines");

  return (
    <ActionForm action={action} className="form bill-form">
      {b && (
        <>
          <input type="hidden" name="id" value={b.id} />
          <input type="hidden" name="version" value={b.version} />
        </>
      )}
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(lines.map(({ description, unit_price, quantity, taxable, note }) => ({ description, unit_price, quantity, taxable, note })))}
      />

      <div className="card form-section">
        <h2>請求書全体</h2>
        <Field label="企業" name="company_id" required error={e.company_id}>
          <select
            id="company_id"
            name="company_id"
            value={companyId}
            onChange={(ev) => {
              setCompanyId(ev.target.value);
              recompute(ev.target.value, issueDate);
            }}
          >
            <option value="">選んでください</option>
            {props.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        {prev && (
          <div className="notice notice-info bill-prev">
            <div>
              前回の請求：{dateLabel(prev.issue_date)}
            </div>
            {hints.length > 0 ? (
              <ul>
                {hints.map((h) => (
                  <li key={h.d}>
                    {h.d} → <strong>今回は {h.next}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <ul>
                {prev.descriptions.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="form-row">
          <Field label="請求日" name="issue_date" required error={e.issue_date}>
            <input
              id="issue_date"
              name="issue_date"
              type="date"
              value={issueDate}
              onChange={(ev) => {
                setIssueDate(ev.target.value);
                recompute(companyId, ev.target.value);
              }}
            />
          </Field>
          <Field label="計上月" name="accounting_month" required error={e.accounting_month} hint="初めは請求日の月。売上表のどの月のシートに書くかもこれで決まります">
            <input
              id="accounting_month"
              name="accounting_month"
              type="month"
              value={month}
              onChange={(ev) => {
                setMonth(ev.target.value);
                setMonthTouched(true);
              }}
            />
          </Field>
          <Field
            label="支払期限"
            name="payment_due_date"
            required
            error={e.payment_due_date}
            hint={company ? "初めは企業の設定から（ふつうは翌月末）" : "企業を選ぶと入ります"}
          >
            <input
              id="payment_due_date"
              name="payment_due_date"
              type="date"
              value={due}
              onChange={(ev) => {
                setDue(ev.target.value);
                setDueTouched(true);
              }}
            />
          </Field>
        </div>

        <div className="form-row">
          <Field
            label="送り方"
            name="send_method"
            asGroup
            hint={company ? `この企業のいつもの送り方：${company.send_method === "email" ? "メール" : "郵送"}` : undefined}
          >
            <div className="choices" role="radiogroup" aria-labelledby="send_method-label">
              <label className="choice">
                <input
                  type="radio"
                  name="send_method"
                  value="post"
                  checked={sendMethod === "post"}
                  onChange={() => {
                    setSendMethod("post");
                    setSendTouched(true);
                  }}
                />
                郵送
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name="send_method"
                  value="email"
                  checked={sendMethod === "email"}
                  onChange={() => {
                    setSendMethod("email");
                    setSendTouched(true);
                  }}
                />
                メール（セレッジ担当が送付）
              </label>
            </div>
          </Field>
          <Field label="担当" name="staff_name" hint="売上表のA列「担当」に入ります">
            <input id="staff_name" name="staff_name" type="text" defaultValue={b ? (b.staff_name ?? "") : props.defaultStaff} />
          </Field>
        </div>
      </div>

      <div className="card form-section">
        <h2>明細</h2>
        <p className="muted small">1行が、企業別シート・売上表・収支一覧のそれぞれ1行になります。内訳の書き方は自由です。</p>
        {lineErrors.length > 0 && (
          <div className="notice notice-error" role="alert">
            <ul>
              {lineErrors.map(([k, m]) => (
                <li key={k}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        <ol className="bill-lines">
          {lines.map((l, i) => (
            <li key={l.key} className="bill-line">
              <div className="bill-line-head">
                <strong>{i + 1}行目</strong>
                <span className="bill-line-tools">
                  <button type="button" className="btn btn-quiet" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`${i + 1}行目を上へ`}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => move(i, 1)} disabled={i === lines.length - 1} aria-label={`${i + 1}行目を下へ`}>
                    ↓
                  </button>
                  <button type="button" className="btn btn-danger-quiet" onClick={() => remove(l.key)}>
                    この行を消す
                  </button>
                </span>
              </div>
              <Field label="内訳（案件名）" name={`d-${l.key}`} error={e[`line-${i}-description`]}>
                <input
                  id={`d-${l.key}`}
                  type="text"
                  value={l.description}
                  placeholder="例：2名：在留サポートサービス費用（5回目/全24回）"
                  onChange={(ev) => update(l.key, { description: ev.target.value })}
                />
              </Field>
              <div className="form-row">
                <Field label="単価（税抜）" name={`p-${l.key}`} error={e[`line-${i}-unit_price`]}>
                  <input id={`p-${l.key}`} type="text" inputMode="numeric" value={l.unit_price} onChange={(ev) => update(l.key, { unit_price: ev.target.value })} />
                </Field>
                <Field label="個数" name={`q-${l.key}`} error={e[`line-${i}-quantity`]}>
                  <input id={`q-${l.key}`} type="text" inputMode="decimal" value={l.quantity} onChange={(ev) => update(l.key, { quantity: ev.target.value })} />
                </Field>
                <div className="field">
                  <span className="label">金額（税抜）</span>
                  <div className="bill-amount">{amounts[i] === null ? "—" : yen(amounts[i])}</div>
                </div>
              </div>
              <div className="form-row">
                <Field label="備考" name={`n-${l.key}`} hint="企業別シートのG列「備考」に入ります">
                  <input id={`n-${l.key}`} type="text" value={l.note} onChange={(ev) => update(l.key, { note: ev.target.value })} />
                </Field>
                <div className="field">
                  <span className="label">消費税</span>
                  <label className="choice">
                    <input type="checkbox" checked={!l.taxable} onChange={(ev) => update(l.key, { taxable: !ev.target.checked })} />
                    消費税がかからない（立替金・通訳の交通費など）
                  </label>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-secondary" onClick={() => setLines((ls) => [...ls, newLine()])}>
          ＋ 行を足す
        </button>

        <dl className="bill-totals">
          <div>
            <dt>{hasNontaxable ? "10％対象" : "小計"}</dt>
            <dd>{yen(totals.taxable)}</dd>
          </div>
          <div>
            <dt>消費税（{Math.round(props.taxRate * 100)}％）</dt>
            <dd>{yen(totals.tax)}</dd>
          </div>
          {hasNontaxable && (
            <div>
              <dt>対象外</dt>
              <dd>{yen(totals.nontaxable)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>合計（税込）</dt>
            <dd>{yen(totals.total)}</dd>
          </div>
        </dl>
      </div>

      <div className="card form-section">
        <Field label="社内メモ" name="memo" hint="請求書にもExcelにも出ません">
          <textarea id="memo" name="memo" defaultValue={b?.memo ?? ""} />
        </Field>
      </div>

      {state.message && <p className={`notice ${state.ok ? "notice-info" : "notice-error"}`}>{state.message}</p>}
      <div className="form-actions sticky-actions">
        <Link href={b ? `/bills/${b.id}` : "/bills"} className="btn btn-quiet">
          やめる
        </Link>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "保存しています…" : "保存する"}
        </button>
      </div>
    </ActionForm>
  );
}
