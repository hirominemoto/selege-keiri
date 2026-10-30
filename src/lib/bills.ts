/** 請求の入力（設計 v1.0）まわりの型と計算。画面の表示用 */

import { addMonths, monthEnd } from "@/lib/billing";
import { monthName, renderTemplate } from "@/lib/contract";

export type BillStatus = "draft" | "issued" | "sent";

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
  sent_on: string | null;
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
  contract_id: string | null;
  count_no: number | null;
  service_month: string | null;
};

/** 状態の言葉。場所（アプリ・企業シートなど）をかならず入れる */
export const billStatusLabel: Record<BillStatus, string> = {
  draft: "アプリに入力済み",
  issued: "請求書作成済み",
  sent: "請求済み",
};

/** 状態の言葉＋番号・送った日（例：請求済み（11/30 郵送）） */
export function billStatusText(b: {
  status: BillStatus;
  invoice_no: string | null;
  sent_on: string | null;
  send_method: "post" | "email";
}): string {
  if (b.status === "sent" && b.sent_on) {
    const [, m, d] = b.sent_on.split("-").map(Number);
    return `請求済み（${m}/${d} ${b.send_method === "email" ? "メール" : "郵送"}）`;
  }
  if (b.status === "issued") return `請求書作成済み${b.invoice_no ? `（№${b.invoice_no}）` : ""}`;
  return billStatusLabel[b.status];
}

/** アプリで入れた、契約の1か月分 */
export type AppEntry = {
  bill_id: string;
  service_month: string;
  count_no: number | null;
  status: BillStatus;
  invoice_no: string | null;
  sent_on: string | null;
  send_method: "post" | "email";
};

/** フォームの明細1行（入力途中なので数字は文字のまま持つ） */
export type LineDraft = {
  key: string;
  description: string;
  unit_price: string;
  quantity: string;
  taxable: boolean;
  note: string;
  // 契約から作った行だけ
  contract_id: string | null;
  count_no: string;
  service_month: string; // "2026-11-01"
};

/** 契約と、その請求の進み具合（contract_next_counts） */
export type ContractState = {
  id: string;
  company_id: string;
  name: string;
  cohort: string | null;
  kind: "monthly" | "on_demand" | "one_time";
  status: "active" | "paused" | "ended";
  quantity: number;
  unit_price: number;
  taxable: boolean;
  service_month_offset: number;
  total_count: number | null;
  count_unit: "回" | "か月";
  description_template: string | null;
  start_month: string | null;
  end_month: string | null;
  base_count: number; // 企業シート（旧Excel）に記入済みの最後の回数
  legacy_last_service_month: string | null; // 企業シート（旧Excel）に記入済みの最後の「◯月分」
  app_entries: AppEntry[]; // アプリで入れた分（新しい月から）
  last_count: number | null;
  next_count: number;
  last_service_month: string | null;
};

export const contractLabel = (c: { name: string; cohort: string | null }) =>
  `${c.name}${c.cohort ? `（${c.cohort}）` : ""}`;

/** 計上月にこの契約を請求すると「◯月分」はいつか */
export const serviceMonthOf = (c: ContractState, accountingMonth: string) =>
  addMonths(accountingMonth, c.service_month_offset);

/**
 * 当月の請求で、最初から行に並べる契約か：継続中・毎月の契約で、その「◯月分」がまだ請求されておらず、
 * 契約期間の中にあり、全回数を超えないもの
 */
export function isDueThisMonth(c: ContractState, accountingMonth: string): boolean {
  if (c.status !== "active" || c.kind !== "monthly") return false;
  const svc = serviceMonthOf(c, accountingMonth);
  if (c.last_service_month && svc <= c.last_service_month) return false;
  if (c.start_month && svc < c.start_month) return false;
  if (c.end_month && svc > c.end_month) return false;
  if (c.total_count !== null && c.next_count > c.total_count) return false;
  return true;
}

/** 契約から明細1行を作る（内訳は契約の品名のひな形から） */
export function lineFromContract(c: ContractState, accountingMonth: string, key: string): LineDraft {
  return {
    key,
    description: renderTemplate(c.description_template, {
      人数: Number(c.quantity),
      契約名: c.name,
      期: c.cohort ?? "",
      対象月: monthName(accountingMonth, c.service_month_offset),
      回数: c.next_count,
      全回数: c.total_count ?? "",
    }),
    unit_price: String(c.unit_price),
    quantity: String(Number(c.quantity)),
    taxable: c.taxable,
    note: "",
    contract_id: c.id,
    count_no: String(c.next_count),
    service_month: serviceMonthOf(c, accountingMonth),
  };
}

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

/**
 * 金額（税抜）= 単価 × 個数。データベース（PostgreSQL の round）と同じく、
 * 0.5 はゼロから遠いほうへ丸める（-50.5 → -51）。小数の計算の誤差（1.1 × 100 = 110.00000000000001）は先に取り除く
 */
export function lineAmount(unitPrice: number, quantity: number): number {
  const x = unitPrice * quantity;
  const abs = Math.round(Math.abs(x) * 1e6) / 1e6;
  return Math.sign(x) * Math.round(abs);
}

/** 小数第2位までの数か（1.1・2.3・0.29 は OK、1.234 は NG） */
export function hasAtMost2Decimals(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
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
