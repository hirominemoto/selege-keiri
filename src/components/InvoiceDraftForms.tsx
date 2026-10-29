"use client";

import { useActionState } from "react";
import { saveInvoiceSettings, saveLine } from "@/app/(app)/billing/actions";
import { ActionForm } from "@/components/ActionForm";
import { Field } from "@/components/Field";

// ---------------------------------------------------------------------
// 送り方・請求日・入金予定日
// ---------------------------------------------------------------------

export function InvoiceSettingsForm(props: {
  id: string;
  version: number;
  sendMethod: string | null;
  sendToEmail: string | null;
  companyUsual: string; // 企業の「いつもの送り方」
  issueDate: string; // 空なら請求月の末日を初期値に
  dueDate: string;
  note: string | null;
}) {
  const [state, action, pending] = useActionState(saveInvoiceSettings, {});
  const e = state.errors ?? {};
  return (
    <ActionForm action={action} className="form card">
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="version" value={props.version} />

      <Field
        label="送り方"
        name="send_method"
        asGroup
        error={e.send_method}
        hint={`この企業のいつもの送り方：${props.companyUsual === "email" ? "メール" : "郵送"}（目安です。請求書ごとに選びます）`}
      >
        <div className="choices" role="radiogroup" aria-labelledby="send_method-label">
          <label className="choice">
            <input type="radio" name="send_method" value="post" defaultChecked={props.sendMethod === "post"} />
            郵送（南條さんが印刷して投函）
          </label>
          <label className="choice">
            <input type="radio" name="send_method" value="email" defaultChecked={props.sendMethod === "email"} />
            メール（セレッジ担当が送付）
          </label>
        </div>
      </Field>

      <Field label="送付先メールアドレス" name="send_to_email" error={e.send_to_email} hint="メールで送るときだけ使います">
        <input id="send_to_email" name="send_to_email" type="email" defaultValue={props.sendToEmail ?? ""} />
      </Field>

      <div className="form-row">
        <Field label="請求日" name="issue_date" error={e.issue_date} hint="初めは請求月の末日">
          <input id="issue_date" name="issue_date" type="date" defaultValue={props.issueDate} />
        </Field>
        <Field label="入金予定日（お支払期限）" name="payment_due_date" error={e.payment_due_date} hint="初めは企業の設定から">
          <input id="payment_due_date" name="payment_due_date" type="date" defaultValue={props.dueDate} />
        </Field>
      </div>

      <Field label="メモ（請求書には出ません）" name="note">
        <textarea id="note" name="note" defaultValue={props.note ?? ""} />
      </Field>

      {state.message && <p className={`notice ${state.ok ? "notice-info" : "notice-error"}`}>{state.message}</p>}
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "保存しています…" : "保存する"}
        </button>
      </div>
    </ActionForm>
  );
}

// ---------------------------------------------------------------------
// 明細1行
// ---------------------------------------------------------------------

export function LineEditor(props: {
  invoiceId: string;
  lineId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  contractAmount: number | null;
  amount: number;
  heading: string; // 例：在留サポートサービス・12月分
}) {
  const [state, action, pending] = useActionState(saveLine, {});
  const e = state.errors ?? {};
  const differs = props.contractAmount !== null && props.contractAmount !== props.amount;
  return (
    <ActionForm action={action} className={`line-editor${differs ? " is-different" : ""}`}>
      <input type="hidden" name="invoice_id" value={props.invoiceId} />
      <input type="hidden" name="line_id" value={props.lineId} />
      <div className="line-editor-head">
        <strong>{props.heading}</strong>
        {differs && (
          <span className="badge badge-warn">
            契約の金額（{props.contractAmount?.toLocaleString("ja-JP")}円）と違います
          </span>
        )}
      </div>
      <Field label="品名" name={`description-${props.lineId}`} error={e.description}>
        <input id={`description-${props.lineId}`} name="description" type="text" defaultValue={props.description} />
      </Field>
      <div className="form-row">
        <Field label="数量" name={`quantity-${props.lineId}`} error={e.quantity}>
          <input id={`quantity-${props.lineId}`} name="quantity" type="text" inputMode="decimal" defaultValue={String(props.quantity)} />
        </Field>
        <Field label="単価（税抜）" name={`unit_price-${props.lineId}`} error={e.unit_price}>
          <input id={`unit_price-${props.lineId}`} name="unit_price" type="text" inputMode="numeric" defaultValue={String(props.unitPrice)} />
        </Field>
      </div>
      {state.message && !state.errors && (
        <p className={`notice ${state.ok ? "notice-info" : "notice-error"}`}>{state.message}</p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {pending ? "保存しています…" : "この明細を保存"}
        </button>
      </div>
    </ActionForm>
  );
}

// ---------------------------------------------------------------------
// 確認つきのボタン・印刷
// ---------------------------------------------------------------------

export function ConfirmButton({ message, children, className }: { message: string; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="submit"
      className={className ?? "btn btn-quiet"}
      onClick={(ev) => {
        if (!window.confirm(message)) ev.preventDefault();
      }}
    >
      {children}
    </button>
  );
}

export function PrintButton() {
  return (
    <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
      印刷・PDFで保存
    </button>
  );
}
