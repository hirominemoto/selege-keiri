import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { addMonths, invoiceTotals, parseMonth, type TaxRounding } from "@/lib/billing";
import { billStatusText, type BillStatus } from "@/lib/bills";
import { currentMonthJst } from "@/lib/dates";
import { dateLabel, monthLabel, sendMethodLabel, yen } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

type Row = {
  id: string;
  issue_date: string;
  status: BillStatus;
  invoice_no: string | null;
  sent_on: string | null;
  send_method: "post" | "email";
  staff_name: string | null;
  companies: { name: string } | null;
  bill_lines: { description: string; amount: number; taxable: boolean; sort: number }[];
};

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; deleted?: string; company?: string }>;
}) {
  const { month, deleted, company } = await searchParams;
  const user = await requireUser();
  const m = parseMonth(month) ?? currentMonthJst();
  const supabase = await createClient();

  // 企業のページから来たときは、その企業の請求を全部の月で出す
  let query = supabase
    .from("bills")
    .select("id, issue_date, status, invoice_no, sent_on, send_method, staff_name, companies(name), bill_lines(description, amount, taxable, sort)");
  query = company
    ? query.eq("company_id", company).order("issue_date", { ascending: false })
    : query.eq("accounting_month", m).order("issue_date");
  const [{ data, error }, { data: settingData }, { data: companyRow }] = await Promise.all([
    query.order("created_at"),
    supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding"]),
    company ? supabase.from("companies").select("id, name").eq("id", company).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  const taxRate = Number(settings.get("tax_rate") ?? 0.1);
  const taxRounding = (settings.get("tax_rounding") ?? "ceil") as TaxRounding;
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    lines: [...r.bill_lines].sort((a, b) => a.sort - b.sort),
    totals: invoiceTotals(r.bill_lines, taxRate, taxRounding),
  }));
  const drafts = rows.filter((r) => r.status === "draft").length;
  const sum = rows.reduce((s, r) => s + r.totals.total, 0);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>{companyRow ? `${companyRow.name}の請求` : "請求の入力"}</h1>
          <p className="lead">
            {companyRow ? (
              <>
                すべての月の請求。<Link href={`/companies/${companyRow.id}`}>企業のページへ戻る</Link>
              </>
            ) : (
              "計上月ごとの請求。1回の入力が1枚の請求書になります。"
            )}
          </p>
        </div>
        {user.role === "admin" && (
          <Link href={companyRow ? `/bills/new?company=${companyRow.id}` : "/bills/new"} className="btn">
            ＋ 新しい請求を入力
          </Link>
        )}
      </div>

      {!companyRow && (
      <div className="month-nav">
        <Link href={`/bills?month=${addMonths(m, -1).slice(0, 7)}`} className="btn btn-secondary">
          ← 前の月
        </Link>
        <form className="month-pick" key={m}>
          <input type="month" name="month" defaultValue={m.slice(0, 7)} aria-label="計上月を選ぶ" />
          <button type="submit" className="btn btn-secondary">
            表示
          </button>
        </form>
        <Link href={`/bills?month=${addMonths(m, 1).slice(0, 7)}`} className="btn btn-secondary">
          次の月 →
        </Link>
      </div>
      )}

      {deleted && <p className="notice notice-info">請求を消しました。</p>}
      {error && <p className="notice notice-error">読み込めませんでした（{error.message}）</p>}

      <div className="summary-chips">
        <span>
          {companyRow ? "請求" : `${monthLabel(m)}の請求`}<strong>{rows.length}件</strong>
        </span>
        <span>
          アプリに入力済み（請求書はまだ）<strong>{drafts}件</strong>
        </span>
        <span>
          合計（税込）<strong>{yen(sum)}</strong>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="empty">{companyRow ? "この企業の請求はまだありません。" : "この月の請求はまだありません。"}</p>
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>請求日</th>
                <th>企業</th>
                <th>内訳</th>
                <th className="num">合計（税込）</th>
                <th>送り方</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{dateLabel(r.issue_date)}</td>
                  <td>
                    <Link href={`/bills/${r.id}`}>{r.companies?.name ?? "—"}</Link>
                  </td>
                  <td>
                    {r.lines[0]?.description ?? "—"}
                    {r.lines.length > 1 && <span className="muted">　ほか{r.lines.length - 1}行</span>}
                  </td>
                  <td className="num">{yen(r.totals.total)}</td>
                  <td>{r.send_method === "email" ? "メール" : sendMethodLabel.post}</td>
                  <td>
                    <span className={`badge ${r.status === "draft" ? "" : "badge-active"}`}>{billStatusText(r)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
