/**
 * 企業ごとの「請求の履歴」：企業シートから取り込んだ行（10/31 まで）と、アプリで入力した請求を、計上月ごとに並べる
 * フォームの履歴の状態は「請求済み／未請求」の2つだけ（11/01 ひろみ決定）
 */
import { contractLabel, isDueThisMonth, type BillStatus, type ContractState } from "./bills";

export type HistoryLine = { description: string; amount: number };

export type HistoryEntry = {
  key: string;
  month: string; // 計上月 "2026-10-01"
  source: "sheet" | "app" | "due";
  status: "billed" | "unbilled";
  amount: number; // 税抜の合計
  lines: HistoryLine[];
  issue_date: string | null;
  bill_id?: string;
  bill_status?: BillStatus;
  invoice_no?: string | null;
};

export type SheetRowIn = { company_id: string; issue_date: string; accounting_month: string; description: string; amount: number; row_no: number; sheet_name: string };
export type BillIn = {
  id: string;
  company_id: string;
  issue_date: string;
  accounting_month: string;
  status: BillStatus;
  invoice_no: string | null;
  bill_lines: { description: string; amount: number; sort: number }[];
};

export function buildHistory(input: {
  sheetRows: SheetRowIn[];
  bills: BillIn[];
  contracts: ContractState[];
  billedUntil: string; // この請求日まで、企業シートの行は請求済み
  currentMonth: string; // "2026-11-01"
}): Record<string, HistoryEntry[]> {
  const out: Record<string, HistoryEntry[]> = {};
  const push = (companyId: string, e: HistoryEntry) => (out[companyId] ??= []).push(e);

  // 企業シートの行：企業・計上月・請求済みかでまとめる
  const groups = new Map<string, SheetRowIn[]>();
  for (const r of input.sheetRows) {
    const billed = r.issue_date <= input.billedUntil;
    const k = `${r.company_id}|${r.accounting_month}|${billed ? 1 : 0}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, rows] of groups) {
    const [companyId, month, billed] = k.split("|");
    rows.sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.row_no - b.row_no);
    push(companyId, {
      key: `sheet-${k}`,
      month,
      source: "sheet",
      status: billed === "1" ? "billed" : "unbilled",
      amount: rows.reduce((s, r) => s + r.amount, 0),
      lines: rows.map((r) => ({ description: r.description, amount: r.amount })),
      issue_date: rows.map((r) => r.issue_date).sort().at(-1) ?? null,
    });
  }

  // アプリの請求：1回の入力 = 1行
  for (const b of input.bills) {
    const lines = [...b.bill_lines].sort((x, y) => x.sort - y.sort);
    push(b.company_id, {
      key: `app-${b.id}`,
      month: b.accounting_month,
      source: "app",
      status: b.status === "draft" ? "unbilled" : "billed",
      amount: lines.reduce((s, l) => s + l.amount, 0),
      lines: lines.map((l) => ({ description: l.description, amount: l.amount })),
      issue_date: b.issue_date,
      bill_id: b.id,
      bill_status: b.status,
      invoice_no: b.invoice_no,
    });
  }

  // 今月：毎月の契約があって、アプリに今月の請求がまだない企業は「未請求」
  const byCompany = new Map<string, ContractState[]>();
  for (const c of input.contracts) byCompany.set(c.company_id, [...(byCompany.get(c.company_id) ?? []), c]);
  for (const [companyId, contracts] of byCompany) {
    const due = contracts.filter((c) => isDueThisMonth(c, input.currentMonth));
    if (due.length === 0) continue;
    const hasThisMonth = (out[companyId] ?? []).some((e) => e.source === "app" && e.month === input.currentMonth);
    if (hasThisMonth) continue;
    push(companyId, {
      key: `due-${companyId}`,
      month: input.currentMonth,
      source: "due",
      status: "unbilled",
      amount: due.reduce((s, c) => s + Math.round(c.unit_price * c.quantity), 0),
      lines: due.map((c) => ({ description: contractLabel(c), amount: Math.round(c.unit_price * c.quantity) })),
      issue_date: null,
    });
  }

  // 新しい月が上。同じ月は アプリ → 企業シート の順、日付の新しい順
  const order = { due: 0, app: 1, sheet: 2 } as const;
  for (const list of Object.values(out)) {
    list.sort(
      (a, b) =>
        b.month.localeCompare(a.month) ||
        order[a.source] - order[b.source] ||
        (b.issue_date ?? "").localeCompare(a.issue_date ?? ""),
    );
  }
  return out;
}
