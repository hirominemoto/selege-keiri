import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { addMonths, billingStateLabel, invoiceStatusLabel, invoiceTotals, parseMonth, type TaxRounding } from "@/lib/billing";
import { monthName, nextCount, renderTemplate } from "@/lib/contract";
import { currentMonthJst } from "@/lib/dates";
import { countLabel, monthLabel, sendMethodLabel, yen } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Contract } from "@/lib/types";
import { BillingSelectForm, type BillingRow } from "@/components/BillingSelectForm";

type StatusRow = {
  contract_id: string;
  company_id: string;
  service_month: string;
  state: string;
  invoice_no: string | null;
  request_id: string | null;
};

type InvoiceRow = {
  id: string;
  company_id: string;
  invoice_no: string | null;
  status: string;
  send_method: string | null;
  total: number | null;
  billing_requests: { billing_request_lines: { amount: number; taxable: boolean }[] }[];
};

// 並び順：まだのもの → 下書き → 済んだもの
const stateOrder: Record<string, number> = {
  unbilled: 0,
  none: 1,
  draft: 2,
  correcting: 3,
  invoiced: 4,
  legacy: 5,
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { month } = await searchParams;
  const user = await requireUser();
  const canEdit = user.role === "admin";
  const billingMonth = parseMonth(month) ?? currentMonthJst();
  const supabase = await createClient();

  const [
    { data: contractData },
    { data: companyData },
    { data: statusData },
    { data: reqData },
    { data: invoiceData },
    { data: settingData },
  ] = await Promise.all([
    supabase.from("contracts").select("*"),
    supabase.from("companies").select("id, name"),
    // 翌月分を前請求する契約があるので、◯月分は請求月と翌月の2か月ぶん見る
    supabase.rpc("contract_billing_status", { p_from: billingMonth, p_to: addMonths(billingMonth, 1) }),
    supabase.from("billing_requests").select("contract_id, count_no, invoice_id, service_month, billing_month")
      .eq("kind", "normal").eq("status", "active"),
    supabase
      .from("invoices")
      .select("id, company_id, invoice_no, status, send_method, total, billing_requests!billing_requests_invoice_id_fkey(billing_request_lines(amount, taxable))")
      .eq("billing_month", billingMonth)
      .not("status", "in", "(cancelled,superseded)")
      .order("created_at"),
    supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding"]),
  ]);

  const contracts = (contractData ?? []) as Contract[];
  const companyName = new Map((companyData ?? []).map((c) => [c.id as string, c.name as string]));
  const statuses = (statusData ?? []) as StatusRow[];
  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  const taxRate = Number(settings.get("tax_rate") ?? 0.1);
  const taxRounding = (settings.get("tax_rounding") ?? "ceil") as TaxRounding;

  const maxCount = new Map<string, number>();
  const invoiceOfRequest = new Map<string, string>(); // contract_id + ◯月分 → 請求書
  for (const r of reqData ?? []) {
    if (r.contract_id && r.count_no !== null) {
      maxCount.set(r.contract_id, Math.max(maxCount.get(r.contract_id) ?? 0, r.count_no));
    }
    if (r.contract_id && r.invoice_id) {
      invoiceOfRequest.set(`${r.contract_id}|${r.service_month ?? r.billing_month}`, r.invoice_id);
    }
  }

  let hidden = 0;
  const rows: BillingRow[] = [];
  for (const c of contracts) {
    const svc = addMonths(billingMonth, c.service_month_offset);
    const st = statuses.find((s) => s.contract_id === c.id && s.service_month === svc);
    const state = st?.state ?? "unbilled";
    if (state === "out_of_scope" || c.status === "ended") {
      hidden++;
      continue;
    }
    const n = nextCount(c.base_count, maxCount.get(c.id) ?? null);
    const selectable = state === "unbilled" || state === "none";
    const showCount = selectable && ((c.description_template ?? "").includes("{回数}") || !c.description_template);
    rows.push({
      contractId: c.id,
      companyId: c.company_id,
      companyName: companyName.get(c.company_id) ?? "",
      contractLabel: `${c.name}${c.cohort ? `（${c.cohort}）` : ""}`,
      kindNote: c.kind === "on_demand" ? "都度請求" : c.kind === "one_time" ? "1回だけ" : c.status === "paused" ? "休止中" : null,
      serviceMonthLabel: `${monthName(billingMonth, c.service_month_offset)}分`,
      countText: showCount ? countLabel(n, c.total_count, c.count_unit) : null,
      countOver: showCount && c.total_count !== null && n > c.total_count,
      description: renderTemplate(c.description_template, {
        人数: Number(c.quantity),
        契約名: c.name,
        期: c.cohort ?? "",
        対象月: monthName(billingMonth, c.service_month_offset),
        回数: n,
        全回数: c.total_count ?? "",
      }),
      amount: Math.round(Number(c.quantity) * c.unit_price),
      state,
      stateLabel: billingStateLabel[state] ?? state,
      invoiceId: invoiceOfRequest.get(`${c.id}|${svc}`) ?? null,
      invoiceNo: st?.invoice_no ?? null,
      // 毎月の契約の「未請求」は最初からチェック、都度請求は請求するときだけ選ぶ
      selectable: selectable && c.status !== "paused",
      defaultChecked: state === "unbilled",
    });
  }
  rows.sort(
    (a, b) =>
      (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9) ||
      a.companyName.localeCompare(b.companyName, "ja") ||
      a.contractLabel.localeCompare(b.contractLabel, "ja"),
  );

  const invoices = ((invoiceData ?? []) as InvoiceRow[]).map((inv) => {
    const lines = inv.billing_requests.flatMap((r) => r.billing_request_lines);
    // 下書きは明細から計算、送付OK以降は送付OKで固まった金額を出す
    const total = inv.status === "draft" || inv.total === null ? invoiceTotals(lines, taxRate, taxRounding).total : inv.total;
    return { ...inv, lineCount: lines.length, total };
  });
  invoices.sort((a, b) => (companyName.get(a.company_id) ?? "").localeCompare(companyName.get(b.company_id) ?? "", "ja"));

  const count = (s: string) => rows.filter((r) => r.state === s).length;
  const prev = addMonths(billingMonth, -1).slice(0, 7);
  const next = addMonths(billingMonth, 1).slice(0, 7);

  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/">ホーム</Link> ／ 今月の請求
      </div>
      <div className="page-head">
        <div>
          <h1>{monthLabel(billingMonth)}の請求</h1>
          <p className="lead">契約から今月請求する分を選んで、下書きを作ります</p>
        </div>
        <div className="month-nav">
          <Link href={`/billing?month=${prev}`} className="btn btn-secondary">
            ← 前の月
          </Link>
          <form className="month-pick" key={billingMonth}>
            <input type="month" name="month" defaultValue={billingMonth.slice(0, 7)} aria-label="請求月を選ぶ" />
            <button type="submit" className="btn btn-secondary">
              表示
            </button>
          </form>
          <Link href={`/billing?month=${next}`} className="btn btn-secondary">
            次の月 →
          </Link>
        </div>
      </div>

      <p className="notice notice-warn">
        お試し版です。下書きは何度作っても、片付けても大丈夫です。「送付OK」（番号が付いて売上になる操作）はまだ出していません。
      </p>

      <div className="summary-chips">
        <span>
          未請求 <strong>{count("unbilled")}</strong>
        </span>
        <span>
          都度請求 <strong>{count("none")}</strong>
        </span>
        <span>
          下書きあり <strong>{count("draft")}</strong>
        </span>
        <span>
          請求済み <strong>{count("invoiced") + count("correcting")}</strong>
        </span>
        <span>
          Excelで請求済み <strong>{count("legacy")}</strong>
        </span>
      </div>

      <section style={{ marginTop: 16 }}>
        <h2>契約ごとの請求状況</h2>
        <BillingSelectForm billingMonth={billingMonth} rows={rows} canEdit={canEdit} />
        {hidden > 0 && (
          <p className="small muted" style={{ marginTop: 8 }}>
            ほかに、契約期間の外・終了した契約が {hidden}件あります（この表には出していません）
          </p>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>{monthLabel(billingMonth)}の請求書</h2>
        <div className="table-wrap">
          {invoices.length === 0 ? (
            <div className="empty">まだ請求書はありません。上の表で契約を選んで、下書きを作ってください</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>企業</th>
                  <th>状態</th>
                  <th>送り方</th>
                  <th className="num">明細</th>
                  <th className="num">合計（税込）</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{companyName.get(inv.company_id)}</td>
                    <td>
                      <span className={`badge${inv.status === "draft" ? "" : " badge-active"}`}>
                        {invoiceStatusLabel[inv.status] ?? inv.status}
                      </span>
                      {inv.invoice_no && <div className="small muted">{inv.invoice_no}</div>}
                    </td>
                    <td>
                      {inv.send_method ? (
                        sendMethodLabel[inv.send_method]
                      ) : (
                        <span className="badge badge-warn">まだ選んでいません</span>
                      )}
                    </td>
                    <td className="num">{inv.lineCount}行</td>
                    <td className="num">{yen(inv.total)}</td>
                    <td>
                      <Link href={`/billing/invoices/${inv.id}`}>開く</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}
