/** 請求の入力（設計 v1.0）まわりの型と計算。画面の表示用 */

import { addMonths, monthEnd } from "@/lib/billing";

export type BillStatus = "draft" | "issued";

export type Bill = {
  id: string;
  company_id: string;
  issue_date: string;
  accounting_month: string;
  payment_due_date: string;
  staff_name: string | null;
  send_method: "post" | "email";
  memo: string | null;
  status: BillStatus;
  invoice_no: string | null;
  issued_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type BillLine = {
  id: string;
  bill_id: string;
  sort: number;
  description: string;
  unit_price: number;
  quantity: number;
  amount: number;
  taxable: boolean;
  note: string | null;
};

export const billStatusLabel: Record<BillStatus, string> = {
  draft: "入力中",
  issued: "請求書あり",
};

/** フォームの明細1行（入力途中なので数字は文字のまま持つ） */
export type LineDraft = {
  key: string;
  description: string;
  unit_price: string;
  quantity: string;
  taxable: boolean;
  note: string;
};

/** 全角数字・カンマ・円を許して数にする。読めなければ null */
export function readNumber(raw: string): number | null {
  const t = raw
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，,円\s]/g, "")
    .replace(/[－ー−]/g, "-");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 金額（税抜）= 単価 × 個数。データベースと同じく四捨五入 */
export function lineAmount(unitPrice: number, quantity: number): number {
  return Math.round(unitPrice * quantity);
}

/**
 * 支払期限の初期値：請求日の月から、企業の設定（何か月後・何日。日が空なら月末）で決める。
 * ふつうは翌月末。
 */
export function defaultDueDate(issueDate: string, months: number, day: number | null): string {
  const base = addMonths(`${issueDate.slice(0, 7)}-01`, months);
  const end = monthEnd(base);
  if (!day) return end;
  const lastDay = Number(end.slice(8, 10));
  return `${base.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** 日本時間の今日 "2026-10-30" */
export function todayJst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 内訳から「5回目/全24回」「（5回目/24回）」「26か月目」を読み取り、次の回数を出す。
 * 書き方は入力者に任せているので、読めないときは null（何も出さない）。
 */
export function nextCountFrom(description: string): string | null {
  const t = description.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = /(\d+)\s*回目\s*[/／]\s*全?\s*(\d+)\s*回/.exec(t);
  if (m) {
    const n = Number(m[1]) + 1;
    const total = Number(m[2]);
    return n > total ? `全${total}回が終わっています（前回 ${m[1]}回目）` : `${n}回目/全${total}回`;
  }
  const k = /(\d+)\s*か月目/.exec(t);
  if (k) return `${Number(k[1]) + 1}か月目`;
  return null;
}
