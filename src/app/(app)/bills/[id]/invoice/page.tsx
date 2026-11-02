import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/InvoiceDraftForms";
import { InvoiceSheet, type SheetLine } from "@/components/InvoiceSheet";
import { requireUser } from "@/lib/auth";
import type { Issuer, TaxRounding, Totals } from "@/lib/billing";
import { billStatusText, type Bill, type BillLine } from "@/lib/bills";
import { createClient } from "@/lib/supabase/server";

/**
 * 請求書（A4・1枚）。印刷・PDF保存もこの画面から。
 * 入力中のうちは「下書き」の透かしつきで、いまの明細から出す。
 * 請求書を作ったあとは、作ったときに固まった金額・宛名で出す。
 */
export default async function BillInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ issued?: string }>;
}) {
  const { id } = await params;
  const { issued } = await searchParams;
  await requireUser();
  const supabase = await createClient();

  const [{ data: billData }, { data: lineData }, { data: settingData }] = await Promise.all([
    supabase.from("bills").select("*, companies(name, honorific)").eq("id", id).maybeSingle(),
    supabase.from("bill_lines").select("*").eq("bill_id", id).order("sort"),
    supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding", "issuer"]),
  ]);
  if (!billData) notFound();
  const bill = billData as Bill & { companies: { name: string; honorific: string } | null };
  const lines = (lineData ?? []) as BillLine[];
  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  const issuer = (settings.get("issuer") ?? {}) as Issuer;

  const isDraft = bill.status === "draft";
  const sheetLines: SheetLine[] = lines.map((l) => ({
    description: l.description,
    quantity: Number(l.quantity),
    unit_price: l.unit_price,
    amount: l.amount,
    taxable: l.taxable,
  }));
  const frozen: Totals | undefined =
    !isDraft && bill.total !== null
      ? {
          taxable: bill.subtotal_taxable ?? 0,
          nontaxable: bill.subtotal_nontaxable ?? 0,
          tax: bill.tax_amount ?? 0,
          total: bill.total,
        }
      : undefined;
  const taxRate = !isDraft && bill.tax_rate !== null ? Number(bill.tax_rate) : Number(settings.get("tax_rate") ?? 0.1);

  return (
    <main className="page">
      <nav className="breadcrumb no-print">
        <Link href="/bills">請求の入力</Link> ／ <Link href={`/bills/${bill.id}`}>請求</Link> ／ 請求書
      </nav>
      <div className="page-head no-print">
        <div>
          <h1>請求書</h1>
          <p className="lead">
            <span className={`badge ${isDraft ? "" : "badge-active"}`}>{billStatusText(bill)}</span>{" "}
            {bill.bill_to_name ?? bill.companies?.name}
          </p>
        </div>
        <div className="form-actions">
          <Link href={`/bills/${bill.id}`} className="btn btn-quiet">
            請求の画面へ戻る
          </Link>
          <PrintButton />
        </div>
      </div>

      {issued && !isDraft && (
        <p className="notice notice-info no-print">
          請求書を作りました（№{bill.invoice_no}）。「印刷・PDFで保存」から印刷やPDF保存ができます。送ったら、請求の画面の「送った」を押してください。
        </p>
      )}
      {isDraft && (
        <p className="notice no-print">
          {bill.invoice_no
            ? `作り直し中の下書きです（№${bill.invoice_no}）。請求の画面で、もう一度「請求書を作る」を押すと金額が固まります。`
            : "まだ下書きです（番号なし）。請求の画面で「請求書を作る」を押すと、番号が付いて金額が固まります。"}
        </p>
      )}

      <section className="invoice-preview">
        <InvoiceSheet
          issuer={issuer}
          billToName={bill.bill_to_name ?? bill.companies?.name ?? ""}
          honorific={bill.honorific ?? bill.companies?.honorific ?? "御中"}
          invoiceNo={bill.invoice_no}
          issueDate={bill.issue_date}
          dueDate={bill.payment_due_date}
          lines={sheetLines}
          taxRate={taxRate}
          taxRounding={(settings.get("tax_rounding") ?? "ceil") as TaxRounding}
          isDraft={isDraft}
          frozenTotals={frozen}
          noPlaceholder="請求書を作ると付きます"
        />
      </section>
    </main>
  );
}
