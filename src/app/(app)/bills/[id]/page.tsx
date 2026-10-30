import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/InvoiceDraftForms";
import { requireUser } from "@/lib/auth";
import { invoiceTotals, type TaxRounding } from "@/lib/billing";
import { billStatusLabel, type Bill, type BillLine } from "@/lib/bills";
import { dateLabel, dateTimeLabel, monthLabel, sendMethodLabel, yen } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { deleteBill } from "../actions";

export default async function BillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const user = await requireUser();
  const canEdit = user.role === "admin";
  const supabase = await createClient();

  const [{ data: billData }, { data: lineData }, { data: settingData }] = await Promise.all([
    supabase.from("bills").select("*, companies(name)").eq("id", id).maybeSingle(),
    supabase.from("bill_lines").select("*").eq("bill_id", id).order("sort"),
    supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding"]),
  ]);
  if (!billData) notFound();
  const bill = billData as Bill & { companies: { name: string } | null };
  const lines = (lineData ?? []) as BillLine[];
  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  const taxRate = Number(settings.get("tax_rate") ?? 0.1);
  const totals = invoiceTotals(lines, taxRate, (settings.get("tax_rounding") ?? "ceil") as TaxRounding);
  const hasNontaxable = totals.nontaxable !== 0;
  const isDraft = bill.status === "draft";

  return (
    <main className="page">
      <nav className="breadcrumb">
        <Link href="/bills">請求の入力</Link> ／ 請求
      </nav>
      <div className="page-head">
        <div>
          <h1>{bill.companies?.name ?? "（企業が見つかりません）"}</h1>
          <p className="lead">
            <span className={`badge ${isDraft ? "" : "badge-active"}`}>{billStatusLabel[bill.status]}</span>{" "}
            {bill.invoice_no && <>請求書№ {bill.invoice_no}　</>}
            請求日 {dateLabel(bill.issue_date)}　計上月 {monthLabel(bill.accounting_month)}
          </p>
        </div>
        {canEdit && isDraft && (
          <Link href={`/bills/${bill.id}/edit`} className="btn">
            直す
          </Link>
        )}
      </div>

      {saved && <p className="notice notice-info">保存しました。</p>}

      <div className="card">
        <h2>明細</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>内訳（案件名）</th>
                <th className="num">単価</th>
                <th className="num">個数</th>
                <th className="num">金額（税抜）</th>
                <th>備考</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.description}
                    {!l.taxable && <span className="badge" style={{ marginLeft: 6 }}>消費税なし</span>}
                  </td>
                  <td className="num">{yen(l.unit_price)}</td>
                  <td className="num">{Number(l.quantity)}</td>
                  <td className="num">{yen(l.amount)}</td>
                  <td>{l.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="bill-totals">
          <div>
            <dt>{hasNontaxable ? "10％対象" : "小計"}</dt>
            <dd>{yen(totals.taxable)}</dd>
          </div>
          <div>
            <dt>消費税（{Math.round(taxRate * 100)}％）</dt>
            <dd>{yen(totals.tax)}</dd>
          </div>
          {hasNontaxable && (
            <div>
              <dt>対象外</dt>
              <dd>{yen(totals.nontaxable)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>合計（税込）</dt>
            <dd>{yen(totals.total)}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <h2>請求書全体</h2>
        <dl className="bill-facts">
          <dt>支払期限</dt>
          <dd>{dateLabel(bill.payment_due_date)}</dd>
          <dt>送り方</dt>
          <dd>{sendMethodLabel[bill.send_method]}</dd>
          <dt>担当</dt>
          <dd>{bill.staff_name ?? "—"}</dd>
          {bill.memo && (
            <>
              <dt>社内メモ</dt>
              <dd>{bill.memo}</dd>
            </>
          )}
          <dt>最後の更新</dt>
          <dd>{dateTimeLabel(bill.updated_at)}</dd>
        </dl>
      </div>

      {canEdit && isDraft && (
        <div className="card">
          <h2>このあと</h2>
          <p className="muted">「請求書を作る」「Excelに書き込む」は、次の段階で作ります。</p>
          <form action={deleteBill} className="form-actions">
            <input type="hidden" name="id" value={bill.id} />
            <ConfirmButton message="この請求を消します。よろしいですか？（入力中なので、消しても請求書番号は使われません）" className="btn btn-danger-quiet">
              この請求を消す
            </ConfirmButton>
          </form>
        </div>
      )}
    </main>
  );
}
