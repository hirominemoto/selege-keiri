/**
 * アプリで入力した請求1件から、3つのExcelに足す行を作る（列の並びはExcelのまま）
 *   企業シート・売上表（月別シート）・収支一覧（売上の明細）
 * いまは画面で見せるだけ。ファイルに書く処理は、この行をそのまま使う
 * 列の対応は docs/decisions.md「フォームとExcelの対応」「収支一覧ブック」
 */

export type ExcelCell = string | number | null;
export type ExcelColumn = { col: string; label: string };
export type ExcelRows = {
  book: "企業シート" | "売上表" | "収支一覧";
  sheet: string;
  sheetNote?: string;
  columns: ExcelColumn[];
  rows: ExcelCell[][];
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

export function excelRowsForBill(bill: BillForExcel, companySheetName: string | null): ExcelRows[] {
  const m = monthNo(bill.accounting_month);
  const year = Number(bill.accounting_month.slice(0, 4));
  const fiscalYear = m >= 8 ? year + 1 : year; // 7月決算：2026年8月〜2027年7月が2027年度
  const pendingNo = bill.invoice_no ?? "（請求書を作ると入ります）";

  const companySheet: ExcelRows = {
    book: "企業シート",
    sheet: companySheetName ?? bill.company_name,
    sheetNote: companySheetName ? "この企業のシートのいちばん下に足します" : "この企業のシートがまだありません（新しいシートを足します）",
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
    notes: ["F 売上金額は、今までどおり式（=D×E）で入れます"],
  };

  const salesSheet: ExcelRows = {
    book: "売上表",
    sheet: `${m}月`,
    sheetNote: `売上表（${fiscalYear}年度）のブックの「${m}月」シート（73行目からの表）に足します`,
    columns: [
      { col: "A", label: "担当" },
      { col: "B", label: "社名" },
      { col: "C", label: "請求書№" },
      { col: "D", label: "内訳" },
      { col: "E", label: "発売日" },
      { col: "F", label: "個数" },
      { col: "G", label: "受注金額" },
      { col: "H", label: "税込" },
      { col: "N", label: "入金予定" },
      { col: "O", label: "入金確認" },
      { col: "P", label: "入金金額" },
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
      bill.payment_due_date,
      null,
      null,
    ]),
    notes: [
      "H 税込は、請求書の合計（税込）を1行目にだけ入れます。2行目からは空けておきます（入金額と見比べやすくするため。行ごとの ×1.1 は書かない）",
      "I〜M列（掲載原価など）は空けたままです",
      "O 入金確認・P 入金金額は空けておきます（ひろみさんが売掛を確かめて記入）",
    ],
  };

  const ledger: ExcelRows = {
    book: "収支一覧",
    sheet: "売上の明細",
    sheetNote: "いちばん下に足します",
    columns: [
      { col: "", label: "年" },
      { col: "", label: "請求月" },
      { col: "", label: "社名" },
      { col: "", label: "内訳" },
      { col: "", label: "受注金額" },
      { col: "", label: "請求金額（税込）" },
      { col: "", label: "入金予定" },
      { col: "", label: "入金日" },
      { col: "", label: "入金金額" },
    ],
    rows: bill.lines.map((l, i) => [
      String(year),
      `${m}月`,
      bill.company_name,
      oneLine(l.description),
      l.amount,
      i === 0 ? bill.invoice_total : null,
      bill.payment_due_date,
      null,
      null,
    ]),
    notes: [
      "請求金額（税込）は、請求書の合計を1行目にだけ入れます（明細が何行あっても、入金額と1対1で見比べられるように）",
      "入金日・入金金額は空けておきます（ひろみさんが記入）",
      `${m}月の合計は、月ごとの一覧（収支一覧表）に、請求金額（税込）を足す式で出ます`,
    ],
  };

  return [companySheet, salesSheet, ledger];
}

/** 内訳の改行は請求書の上だけのもの。Excelには1行にして書く */
function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, "");
}
