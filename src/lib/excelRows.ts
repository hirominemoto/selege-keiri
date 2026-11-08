/**
 * アプリで入力した請求1件から、3つのExcelに足す行を作る（列の並びはExcelのまま）
 *   企業シート・売上表（月別シート）・収支一覧（売上の明細）
 * 請求の画面の見本と、「Excelへの記入」で書き足す行は、どちらもここで作る（toSheetEdit で xlsxWrite に渡す）
 * 列の対応は docs/decisions.md「フォームとExcelの対応」「収支一覧ブック」
 */

import type { SheetEdit, WriteRow } from "@/lib/xlsxWrite";

export type ExcelCell = string | number | null;
export type ExcelColumn = { col: string; label: string };
export type ExcelRows = {
  book: "企業シート" | "売上表" | "収支一覧";
  sheet: string;
  sheetNote?: string;
  columns: ExcelColumn[];
  rows: ExcelCell[][];
  /** 書き足すときの、表の始まりの行と「空いている行」を見分ける列 */
  startRow?: number;
  keyCol?: string;
  notes: string[];
};

export type BillForExcel = {
  company_name: string;
  issue_date: string; // "2026-11-30"
  accounting_month: string; // "2026-11-01"
  payment_due_date: string;
  staff_name: string | null;
  invoice_no: string | null;
  invoice_total: number; // 請求書の合計（税込）。消費税は請求書全体で1回だけ端数処理したもの
  lines: { description: string; unit_price: number; quantity: number; amount: number; taxable: boolean; note: string | null }[];
};

const monthNo = (d: string) => Number(d.slice(5, 7));
/** 同じ請求書の2行目からの入金予定（今までのExcelと同じ書き方。11/03 ひろみ決定） */
export const DITTO = "〃";
/** 収支一覧の、売上の明細のシート */
export const LEDGER_SHEET = "売上（NEW）";

export function excelRowsForBill(bill: BillForExcel, companySheetName: string | null): ExcelRows[] {
  const m = monthNo(bill.accounting_month);
  const year = Number(bill.accounting_month.slice(0, 4));
  const fiscalYear = m >= 8 ? year + 1 : year; // 7月決算：2026年8月〜2027年7月が2027年度
  const pendingNo = bill.invoice_no ?? "（請求書を作ると入ります）";

  const companySheet: ExcelRows = {
    book: "企業シート",
    sheet: companySheetName ?? bill.company_name,
    sheetNote: companySheetName
      ? "この企業のシートの、いちばん下の明細の次の行から足します"
      : "企業シートを取り込んだときに、この企業のシートはありませんでした（ファイルに企業のシートがなければ、書きません）",
    columns: [
      { col: "A", label: "請求日" },
      { col: "B", label: "クライアント名" },
      { col: "C", label: "案件名" },
      { col: "D", label: "単価" },
      { col: "E", label: "個数" },
      { col: "F", label: "売上金額（税抜）" },
      { col: "G", label: "備考" },
      { col: "H", label: "計上月" },
      { col: "I", label: "支払期限" },
    ],
    rows: bill.lines.map((l) => [
      bill.issue_date,
      `${bill.company_name}（${m}月）`,
      oneLine(l.description),
      l.unit_price,
      l.quantity,
      l.amount,
      l.note || null,
      `${m}月`,
      bill.payment_due_date,
    ]),
    notes: [
      "B クライアント名は、そのシートで今まで使ってきた社名の書き方に「（◯月）」を付けます",
      "F 売上金額は、今までどおり式（=D×E）で入れます（空いている行に前もって入っている式を使います）",
    ],
  };

  const salesSheet: ExcelRows = {
    book: "売上表",
    sheet: `${m}月`,
    sheetNote: `売上表（${fiscalYear}年度）のブックの「${m}月」シートの、B 社名が空いているいちばん上の行から足します`,
    startRow: 2,
    keyCol: "B",
    columns: [
      { col: "A", label: "担当" },
      { col: "B", label: "社名" },
      { col: "C", label: "請求書№" },
      { col: "D", label: "商品名（内訳）" },
      { col: "E", label: "発売日" },
      { col: "F", label: "個数" },
      { col: "G", label: "受注金額" },
      { col: "H", label: "税込" },
      { col: "N", label: "入金予定" },
    ],
    rows: bill.lines.map((l, i) => [
      bill.staff_name,
      bill.company_name,
      pendingNo,
      oneLine(l.description),
      "-",
      l.quantity,
      l.amount,
      i === 0 ? bill.invoice_total : null,
      i === 0 ? bill.payment_due_date : DITTO,
    ]),
    notes: [
      "H 税込は、請求書の合計（税込）を1行目にだけ入れます。2行目からは空けておきます（入金額と見比べやすくするため）",
      "N 入金予定は、1行目に日付、2行目からは「〃」",
      "I〜M列（掲載原価など）と O 入金確認・P 入金金額は空けておきます（入金はひろみさんが売掛を確かめて記入）",
    ],
  };

  const ledger: ExcelRows = {
    book: "収支一覧",
    sheet: LEDGER_SHEET,
    sheetNote: "B 請求月が空いているいちばん上の行から足します",
    startRow: 2,
    keyCol: "B",
    columns: [
      { col: "B", label: "請求月" },
      { col: "C", label: "社名" },
      { col: "D", label: "内訳" },
      { col: "E", label: "受注金額" },
      { col: "F", label: "請求額（税込）" },
      { col: "G", label: "入金予定" },
    ],
    rows: bill.lines.map((l, i) => [
      (year % 100) * 100 + m,
      bill.company_name,
      oneLine(l.description),
      l.amount,
      i === 0 ? bill.invoice_total : null,
      i === 0 ? bill.payment_due_date : DITTO,
    ]),
    notes: [
      `B 請求月は「${(year % 100) * 100 + m}」のように年と月の数字で入れます（収支一覧2027（NEW）の SUMIF がこの列で月を見分けます）`,
      "F 請求額（税込）は、請求書の合計を1行目にだけ入れます（明細が何行あっても、入金額と1対1で見比べられるように）",
      "G 入金予定は、1行目に日付、2行目からは「〃」",
      "H 入金日・I 入金金額は空けておきます（ひろみさんが記入）",
    ],
  };

  return [companySheet, salesSheet, ledger];
}

/** 内訳の改行は請求書の上だけのもの。Excelには1行にして書く */
export function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, "");
}

/** 見本の行（ExcelRows）を、書き足す部品（xlsxWrite）に渡す形にする。日付の文字は Excel の日付にする */
export function toSheetEdit(b: ExcelRows): SheetEdit {
  return {
    sheet: b.sheet,
    startRow: b.startRow ?? 2,
    keyCol: b.keyCol ?? "B",
    rows: b.rows.map((r) => {
      const out: WriteRow = {};
      r.forEach((v, i) => {
        const col = b.columns[i]?.col;
        if (!col || v === null || v === "") return;
        out[col] = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : v;
      });
      return out;
    }),
  };
}
