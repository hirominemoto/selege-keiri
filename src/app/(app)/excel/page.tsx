import Link from "next/link";
import { ExcelWriteForm, type ExcelWriteItem } from "@/components/ExcelWriteForm";
import { requireUser } from "@/lib/auth";
import { addMonths, parseMonth } from "@/lib/billing";
import type { Bill, BillLine } from "@/lib/bills";
import { currentMonthJst } from "@/lib/dates";
import { excelRowsForBill, LEDGER_SHEET, toSheetEdit } from "@/lib/excelRows";
import { monthLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type Written = {
  bill_id: string;
  book: "sales" | "ledger" | "company";
  sheet: string;
  first_row: number;
  last_row: number;
  file_name: string | null;
  written_at: string;
};

/**
 * Excelへの記入：計上月を選び、その月の請求（請求書を作ったもの）を売上表・収支一覧に書き足す
 * ファイルはブラウザの中だけで読み書きする。サーバーには「どの請求を何行目に書いたか」だけを残す
 */
export default async function ExcelPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams;
  const user = await requireUser();
  const canEdit = user.role === "admin";
  const m = parseMonth(month) ?? currentMonthJst();
  const mNo = Number(m.slice(5, 7));
  const supabase = await createClient();

  const { data: billData } = await supabase
    .from("bills")
    .select("*, companies(name), bill_lines(*)")
    .eq("accounting_month", m)
    .order("invoice_no", { ascending: true, nullsFirst: false })
    .order("created_at");
  const all = (billData ?? []) as (Bill & { companies: { name: string } | null; bill_lines: BillLine[] })[];
  const issued = all.filter((b) => b.status !== "draft");
  const drafts = all.length - issued.length;

  const { data: writtenData } = issued.length
    ? await supabase
        .from("bill_excel_writes")
        .select("bill_id, book, sheet, first_row, last_row, file_name, written_at")
        .in("bill_id", issued.map((b) => b.id))
    : { data: [] };
  const written = (writtenData ?? []) as Written[];

  const items = (book: "sales" | "ledger"): ExcelWriteItem[] =>
    issued.map((b) => {
      const lines = [...b.bill_lines].sort((x, y) => x.sort - y.sort);
      const books = excelRowsForBill(
        {
          company_name: b.companies?.name ?? "",
          issue_date: b.issue_date,
          accounting_month: b.accounting_month,
          payment_due_date: b.payment_due_date,
          staff_name: b.staff_name,
          invoice_no: b.invoice_no,
          invoice_total: b.total ?? 0,
          lines: lines.map((l) => ({ ...l, quantity: Number(l.quantity), note: l.note ?? null })),
        },
        null,
      );
      const rows = books.find((x) => x.book === (book === "sales" ? "売上表" : "収支一覧"))!;
      const edit = toSheetEdit(rows);
      const w = written.find((x) => x.bill_id === b.id && x.book === book) ?? null;
      // ファイルにもう書いてあるかを見分ける目印（1行目の値）
      const first = edit.rows[0] ?? {};
      const marks = book === "sales" ? { C: first.C } : { B: first.B, C: first.C, D: first.D };
      return {
        billId: b.id,
        invoiceNo: b.invoice_no ?? "",
        company: b.companies?.name ?? "",
        total: b.total ?? 0,
        lineCount: lines.length,
        rows: edit.rows,
        marks: Object.fromEntries(Object.entries(marks).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<
          string,
          string | number
        >,
        written: w ? { sheet: w.sheet, firstRow: w.first_row, lastRow: w.last_row, fileName: w.file_name, at: w.written_at } : null,
        // 書いたあとに「作り直す」で請求書を作り直した
        reissuedAfterWrite: !!(w && b.issued_at && b.issued_at > w.written_at),
      };
    });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Excelへの記入</h1>
          <p className="lead">
            請求書を作った請求を、売上表と収支一覧に書き足します。Excelファイルは、このパソコンのブラウザの中だけで読み書きします（サーバーには送りません）。
          </p>
        </div>
      </div>

      <div className="month-nav">
        <Link href={`/excel?month=${addMonths(m, -1).slice(0, 7)}`} className="btn btn-secondary">
          ← 前の月
        </Link>
        <form className="month-pick" key={m}>
          <input type="month" name="month" defaultValue={m.slice(0, 7)} aria-label="計上月を選ぶ" />
          <button type="submit" className="btn btn-secondary">
            表示
          </button>
        </form>
        <Link href={`/excel?month=${addMonths(m, 1).slice(0, 7)}`} className="btn btn-secondary">
          次の月 →
        </Link>
      </div>

      <div className="summary-chips">
        <span>
          {monthLabel(m)}の請求書<strong>{issued.length}件</strong>
        </span>
        {drafts > 0 && (
          <span>
            アプリに入力済み（請求書はまだ）<strong>{drafts}件</strong>
          </span>
        )}
      </div>
      {drafts > 0 && (
        <p className="notice">
          請求書をまだ作っていない請求が{drafts}件あります。Excelに書けるのは、請求書を作った請求だけです（請求書番号が決まってから書くため）。
        </p>
      )}

      {issued.length === 0 ? (
        <p className="empty">この月に、請求書を作った請求はまだありません。</p>
      ) : (
        <>
          <ExcelWriteForm
            book="sales"
            title="売上表"
            sheet={`${mNo}月`}
            hint={`売上表（年度ごとのブック）の「${mNo}月」シートに書きます。`}
            items={items("sales")}
            canEdit={canEdit}
          />
          <ExcelWriteForm
            book="ledger"
            title="収支一覧"
            sheet={LEDGER_SHEET}
            hint={`収支一覧の「${LEDGER_SHEET}」シートに書きます。月の合計は「収支一覧2027（NEW）」に式で出ます。`}
            items={items("ledger")}
            canEdit={canEdit}
          />
        </>
      )}
    </main>
  );
}
