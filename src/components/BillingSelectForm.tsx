"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createDrafts } from "@/app/(app)/billing/actions";
import { ActionForm } from "@/components/ActionForm";

export type BillingRow = {
  contractId: string;
  companyId: string;
  companyName: string;
  contractLabel: string;
  kindNote: string | null;
  serviceMonthLabel: string; // 例：12月分
  countText: string | null; // 例：3回目／全24回
  countOver: boolean;
  description: string; // 請求書の品名（予定）
  amount: number; // 税抜
  state: string;
  stateLabel: string;
  invoiceId: string | null;
  invoiceNo: string | null;
  selectable: boolean;
  defaultChecked: boolean;
};

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

export function BillingSelectForm({
  billingMonth,
  rows,
  canEdit,
}: {
  billingMonth: string;
  rows: BillingRow[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(createDrafts, {});
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(rows.filter((r) => r.selectable && r.defaultChecked).map((r) => r.contractId)),
  );
  const selectable = rows.filter((r) => r.selectable);
  const total = rows.filter((r) => checked.has(r.contractId)).reduce((s, r) => s + r.amount, 0);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ActionForm action={action}>
      <input type="hidden" name="billing_month" value={billingMonth} />
      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">この月に請求する契約はありません</div>
        ) : (
          <table>
            <thead>
              <tr>
                {canEdit && (
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      aria-label="未請求をすべて選ぶ"
                      checked={selectable.length > 0 && selectable.every((r) => checked.has(r.contractId))}
                      onChange={(e) =>
                        setChecked(e.target.checked ? new Set(selectable.map((r) => r.contractId)) : new Set())
                      }
                      disabled={selectable.length === 0}
                    />
                  </th>
                )}
                <th>企業・契約</th>
                <th>◯月分・回数</th>
                <th className="num">金額（税抜）</th>
                <th>状況</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.contractId} className={r.selectable ? undefined : "row-done"}>
                  {canEdit && (
                    <td>
                      {r.selectable && (
                        <input
                          type="checkbox"
                          name="contract_id"
                          value={r.contractId}
                          aria-label={`${r.companyName} ${r.contractLabel} を選ぶ`}
                          checked={checked.has(r.contractId)}
                          onChange={() => toggle(r.contractId)}
                        />
                      )}
                    </td>
                  )}
                  <td>
                    <Link href={`/companies/${r.companyId}`}>{r.companyName}</Link>
                    <div className="small">
                      {r.contractLabel}
                      {r.kindNote && <span className="muted">（{r.kindNote}）</span>}
                    </div>
                    {r.selectable && <div className="small muted">品名：{r.description}</div>}
                  </td>
                  <td>
                    {r.serviceMonthLabel}
                    {r.countText && <div className="small muted">{r.countText}</div>}
                    {r.countOver && <span className="badge badge-warn">全回数を超えます</span>}
                  </td>
                  <td className="num">{yen(r.amount)}</td>
                  <td>
                    <span className={`badge state-${r.state}`}>{r.stateLabel}</span>
                    {r.invoiceNo && <div className="small muted">{r.invoiceNo}</div>}
                    {r.invoiceId && (
                      <div className="small">
                        <Link href={`/billing/invoices/${r.invoiceId}`}>請求書を開く</Link>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canEdit && selectable.length > 0 && (
        <div className="sticky-actions">
          <div>
            <strong>{checked.size}件</strong>を選択中
            <span className="muted">（税抜 {yen(total)}）</span>
          </div>
          <button type="submit" className="btn" disabled={pending || checked.size === 0}>
            {pending ? "作っています…" : "選んだ契約の下書きを作る"}
          </button>
        </div>
      )}
      {state.message && (
        <p className={`notice ${state.ok ? "notice-info" : "notice-error"}`} style={{ marginTop: 12 }}>
          {state.message}
        </p>
      )}
    </ActionForm>
  );
}
