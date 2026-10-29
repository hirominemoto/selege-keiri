import Link from "next/link";
import { notFound } from "next/navigation";
import { discardDraft, removeRequest } from "@/app/(app)/billing/actions";
import { InvoiceSheet, type SheetLine } from "@/components/InvoiceSheet";
import { ConfirmButton, InvoiceSettingsForm, LineEditor, PrintButton } from "@/components/InvoiceDraftForms";
import { requireUser } from "@/lib/auth";
import { invoiceStatusLabel, monthEnd, type Issuer, type TaxRounding } from "@/lib/billing";
import { monthLabel, sendMethodLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Company } from "@/lib/types";

type Line = {
  id: string;
  sort: number;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  contract_amount: number | null;
};

type Req = {
  id: string;
  service_month: string | null;
  count_no: number | null;
  created_at: string;
  contracts: { name: string; cohort: string | null } | null;
  billing_request_lines: Line[];
};

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const canEdit = user.role === "admin";
  const supabase = await createClient();

  const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).maybeSingle();
  if (!inv) notFound();

  const [{ data: companyData }, { data: reqData }, { data: settingData }, { data: frozenLines }, { data: due }] =
    await Promise.all([
      supabase.from("companies").select("*").eq("id", inv.company_id).single(),
      supabase
        .from("billing_requests")
        .select("id, service_month, count_no, created_at, contracts(name, cohort), billing_request_lines(*)")
        .eq("invoice_id", id)
        .order("created_at"),
      supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding", "issuer"]),
      supabase.from("invoice_lines").select("*").eq("invoice_id", id).order("sort"),
      supabase.rpc("default_due_date", { p_company_id: inv.company_id, p_billing_month: inv.billing_month }),
    ]);
  const company = companyData as Company;
  const requests = (reqData ?? []) as unknown as Req[];
  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  const issuer = (settings.get("issuer") ?? {}) as Issuer;

  const isDraft = inv.status === "draft";
  // 下書きは依頼の明細から、送付OK以降は固まった明細と金額から表示する
  const draftLines = requests.flatMap((r) =>
    [...r.billing_request_lines].sort((a, b) => a.sort - b.sort).map((l) => ({ req: r, line: l })),
  );
  const sheetLines: SheetLine[] = isDraft
    ? draftLines.map(({ line }) => line)
    : ((frozenLines ?? []) as Line[]);
  const taxRate = isDraft ? Number(settings.get("tax_rate") ?? 0.1) : Number(inv.tax_rate);
  const taxRounding = (settings.get("tax_rounding") ?? "ceil") as TaxRounding;

  const issueDate = (inv.issue_date as string | null) ?? monthEnd(inv.billing_month);
  const dueDate = (inv.payment_due_date as string | null) ?? (due as string | null) ?? "";

  const heading = (r: Req) => {
    const c = r.contracts;
    const name = c ? `${c.name}${c.cohort ? `（${c.cohort}）` : ""}` : "追加の請求";
    const svc = r.service_month ? `・${Number(r.service_month.slice(5, 7))}月分` : "";
    return `${name}${svc}`;
  };

  return (
    <main className="page">
      <div className="breadcrumb no-print">
        <Link href="/">ホーム</Link> ／{" "}
        <Link href={`/billing?month=${inv.billing_month.slice(0, 7)}`}>{monthLabel(inv.billing_month)}の請求</Link> ／{" "}
        {company.name}
      </div>
      <div className="page-head no-print">
        <div>
          <h1>
            {company.name} <span className="badge">{invoiceStatusLabel[inv.status] ?? inv.status}</span>
          </h1>
          <p className="lead">
            {monthLabel(inv.billing_month)}の請求
            {inv.invoice_no && `・${inv.invoice_no}`}
            {!isDraft && inv.send_method && `・${sendMethodLabel[inv.send_method]}`}
          </p>
        </div>
        <PrintButton />
      </div>

      {isDraft && canEdit && (
        <div className="invoice-workspace no-print">
          <section>
            <h2>1. 明細を確かめる</h2>
            {draftLines.length === 0 ? (
              <div className="card">
                <p className="muted" style={{ margin: 0 }}>
                  明細がありません。「今月の請求」に戻って契約を選ぶか、この下書きを片付けてください。
                </p>
              </div>
            ) : (
              <div className="line-list">
                {draftLines.map(({ req, line }) => (
                  <div key={line.id} className="card">
                    <LineEditor
                      invoiceId={id}
                      lineId={line.id}
                      description={line.description}
                      quantity={Number(line.quantity)}
                      unitPrice={line.unit_price}
                      amount={line.amount}
                      contractAmount={line.contract_amount}
                      heading={heading(req)}
                    />
                    <form action={removeRequest} className="line-remove">
                      <input type="hidden" name="request_id" value={req.id} />
                      <input type="hidden" name="invoice_id" value={id} />
                      <ConfirmButton message="この明細を請求書から外します。契約は「未請求」に戻ります。よろしいですか？">
                        この明細を外す
                      </ConfirmButton>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2>2. 送り方と日付を選ぶ</h2>
            <InvoiceSettingsForm
              id={id}
              version={inv.version}
              sendMethod={inv.send_method}
              sendToEmail={inv.send_to_email ?? company.email}
              companyUsual={company.send_method}
              issueDate={issueDate}
              dueDate={dueDate}
              note={inv.note}
            />
            <div className="card next-step">
              <h2 style={{ marginBottom: 6 }}>3. 送付OK</h2>
              <p className="small muted" style={{ margin: 0 }}>
                お試し版のため、まだ押せません。送付OKにすると請求書番号が付き、売上になります。
              </p>
            </div>
          </section>
        </div>
      )}

      <section className="invoice-preview">
        <h2 className="no-print">請求書の見え方</h2>
        <InvoiceSheet
          issuer={issuer}
          billToName={isDraft ? company.name : (inv.bill_to_name ?? company.name)}
          honorific={isDraft ? company.honorific : (inv.honorific ?? company.honorific)}
          invoiceNo={inv.invoice_no}
          issueDate={issueDate}
          dueDate={dueDate || null}
          lines={sheetLines}
          taxRate={taxRate}
          taxRounding={taxRounding}
          isDraft={isDraft}
        />
      </section>

      {isDraft && canEdit && (
        <form action={discardDraft} className="no-print" style={{ marginTop: 24 }}>
          <input type="hidden" name="invoice_id" value={id} />
          <input type="hidden" name="billing_month" value={inv.billing_month} />
          <ConfirmButton
            className="btn btn-danger-quiet"
            message="この下書きを片付けます。載っている明細も消え、契約は「未請求」に戻ります。よろしいですか？"
          >
            この下書きを片付ける
          </ConfirmButton>
        </form>
      )}
    </main>
  );
}
