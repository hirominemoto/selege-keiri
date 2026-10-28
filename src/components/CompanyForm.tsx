"use client";

import Link from "next/link";
import { useActionState } from "react";
import { saveCompany } from "@/app/(app)/companies/actions";
import { ActionForm } from "@/components/ActionForm";
import { Field } from "@/components/Field";
import type { Company } from "@/lib/types";

export function CompanyForm({ company }: { company?: Company }) {
  const [state, action, pending] = useActionState(saveCompany, {});
  const e = state.errors ?? {};
  const c = company;

  return (
    <ActionForm action={action} className="form card">
      {c && (
        <>
          <input type="hidden" name="id" value={c.id} />
          <input type="hidden" name="version" value={c.version} />
        </>
      )}

      <div className="form-section">
        <h2>宛名</h2>
        <div className="form-row">
          <Field label="企業名" name="name" required error={e.name} hint="請求書の宛名になります。「株式会社」まで正確に">
            <input id="name" name="name" type="text" defaultValue={c?.name} required />
          </Field>
          <Field label="敬称" name="honorific" hint="ふつうは「御中」">
            <input id="honorific" name="honorific" type="text" defaultValue={c?.honorific ?? "御中"} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="部署" name="department" error={e.department}>
            <input id="department" name="department" type="text" defaultValue={c?.department ?? ""} />
          </Field>
          <Field label="担当者" name="contact_name" error={e.contact_name}>
            <input id="contact_name" name="contact_name" type="text" defaultValue={c?.contact_name ?? ""} />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <h2>住所・連絡先</h2>
        <div className="form-row">
          <Field label="郵便番号" name="postal_code" error={e.postal_code} hint="例：530-0001">
            <input id="postal_code" name="postal_code" type="text" inputMode="numeric" defaultValue={c?.postal_code ?? ""} />
          </Field>
          <Field label="電話番号" name="phone" error={e.phone}>
            <input id="phone" name="phone" type="tel" defaultValue={c?.phone ?? ""} />
          </Field>
        </div>
        <Field label="住所" name="address1" error={e.address1}>
          <input id="address1" name="address1" type="text" defaultValue={c?.address1 ?? ""} />
        </Field>
        <Field label="住所（建物名・階）" name="address2" error={e.address2}>
          <input id="address2" name="address2" type="text" defaultValue={c?.address2 ?? ""} />
        </Field>
      </div>

      <div className="form-section">
        <h2>請求書の送り方と入金予定</h2>
        <Field label="いつもの送り方" name="send_method" asGroup>
          <div className="choices" role="radiogroup" aria-labelledby="send_method-label">
            <label className="choice">
              <input type="radio" name="send_method" value="post" defaultChecked={(c?.send_method ?? "post") === "post"} />
              郵送
            </label>
            <label className="choice">
              <input type="radio" name="send_method" value="email" defaultChecked={c?.send_method === "email"} />
              メール（セレッジ担当が送付）
            </label>
          </div>
        </Field>
        <Field label="請求書の送付先メールアドレス" name="email" error={e.email} hint="メールで送る企業は必須">
          <input id="email" name="email" type="email" defaultValue={c?.email ?? ""} />
        </Field>
        <div className="form-row">
          <Field
            label="入金予定：請求月の何か月後"
            name="payment_due_months"
            error={e.payment_due_months}
            hint="翌月なら 1"
          >
            <input
              id="payment_due_months"
              name="payment_due_months"
              type="text"
              inputMode="numeric"
              defaultValue={c?.payment_due_months ?? 1}
            />
          </Field>
          <Field label="入金予定：何日" name="payment_due_day" error={e.payment_due_day} hint="空なら月末">
            <input
              id="payment_due_day"
              name="payment_due_day"
              type="text"
              inputMode="numeric"
              defaultValue={c?.payment_due_day ?? ""}
            />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <Field label="メモ" name="note">
          <textarea id="note" name="note" defaultValue={c?.note ?? ""} />
        </Field>
        {c && (
          <Field label="取引の状態" name="is_active" asGroup>
            <div className="choices" role="radiogroup" aria-labelledby="is_active-label">
              <label className="choice">
                <input type="radio" name="is_active" value="true" defaultChecked={c.is_active} />
                取引中
              </label>
              <label className="choice">
                <input type="radio" name="is_active" value="false" defaultChecked={!c.is_active} />
                取引終了
              </label>
            </div>
          </Field>
        )}
      </div>

      {state.message && <p className="notice notice-error">{state.message}</p>}
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "保存しています…" : c ? "変更を保存" : "登録する"}
        </button>
        <Link href={c ? `/companies/${c.id}` : "/companies"} className="btn btn-secondary">
          やめる
        </Link>
      </div>
    </ActionForm>
  );
}
