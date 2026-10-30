import type { TaxRounding } from "@/lib/billing";
import type { AppEntry, ContractState } from "@/lib/bills";
import type { CompanyOption } from "@/components/BillForm";
import type { PreviousBill } from "@/components/CompanyBillingPanel";
import { createClient } from "@/lib/supabase/server";

type BillRow = {
  id: string;
  company_id: string;
  issue_date: string;
  accounting_month: string;
  invoice_no: string | null;
  status: PreviousBill["status"];
  sent_on: string | null;
  send_method: "post" | "email";
  bill_lines: { description: string; unit_price: number; quantity: number; amount: number; taxable: boolean; sort: number }[];
};

/** 契約と回数（companyId を渡すとその企業だけ） */
export async function loadContractStates(companyId?: string): Promise<ContractState[]> {
  const supabase = await createClient();
  let q = supabase
    .from("contracts")
    .select("id, company_id, name, cohort, kind, status, quantity, unit_price, taxable, service_month_offset, total_count, count_unit, description_template, start_month, end_month, base_count, legacy_last_service_month")
    .order("name")
    .order("cohort");
  if (companyId) q = q.eq("company_id", companyId);
  let lq = supabase
    .from("bill_lines")
    .select("contract_id, count_no, service_month, bills!inner(id, company_id, status, invoice_no, sent_on, send_method)")
    .not("contract_id", "is", null);
  if (companyId) lq = lq.eq("bills.company_id", companyId);
  const [{ data: contracts }, { data: counts }, { data: lineData }] = await Promise.all([
    q,
    supabase.rpc("contract_next_counts", { p_company_id: companyId ?? null }),
    lq,
  ]);
  type LineRow = {
    contract_id: string;
    count_no: number | null;
    service_month: string | null;
    bills: { id: string; status: AppEntry["status"]; invoice_no: string | null; sent_on: string | null; send_method: "post" | "email" };
  };
  const entries = new Map<string, AppEntry[]>();
  for (const l of (lineData ?? []) as unknown as LineRow[]) {
    if (!l.service_month) continue;
    const list = entries.get(l.contract_id) ?? [];
    list.push({
      bill_id: l.bills.id,
      service_month: l.service_month,
      count_no: l.count_no,
      status: l.bills.status,
      invoice_no: l.bills.invoice_no,
      sent_on: l.bills.sent_on,
      send_method: l.bills.send_method,
    });
    entries.set(l.contract_id, list);
  }
  const byId = new Map(
    ((counts ?? []) as { contract_id: string; last_count: number | null; next_count: number; last_service_month: string | null }[]).map(
      (r) => [r.contract_id, r],
    ),
  );
  return (contracts ?? []).map((c) => {
    const n = byId.get(c.id);
    return {
      ...c,
      quantity: Number(c.quantity),
      app_entries: (entries.get(c.id) ?? []).sort((a, b) => b.service_month.localeCompare(a.service_month)),
      last_count: n?.last_count ?? null,
      next_count: n?.next_count ?? 1,
      last_service_month: n?.last_service_month ?? null,
    } as ContractState;
  });
}

/** 企業ごとの前回の請求（companyId を渡すとその企業だけ）。excludeBillId は今直している請求 */
export async function loadPreviousBills(companyId?: string, excludeBillId?: string): Promise<Record<string, PreviousBill>> {
  const supabase = await createClient();
  let q = supabase
    .from("bills")
    .select("id, company_id, issue_date, accounting_month, invoice_no, status, sent_on, send_method, bill_lines(description, unit_price, quantity, amount, taxable, sort)")
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(companyId ? 5 : 500);
  if (companyId) q = q.eq("company_id", companyId);
  const { data } = await q;
  const previous: Record<string, PreviousBill> = {};
  for (const b of (data ?? []) as BillRow[]) {
    if (b.id === excludeBillId || previous[b.company_id]) continue;
    previous[b.company_id] = {
      id: b.id,
      issue_date: b.issue_date,
      accounting_month: b.accounting_month,
      invoice_no: b.invoice_no,
      status: b.status,
      sent_on: b.sent_on,
      send_method: b.send_method,
      lines: [...b.bill_lines].sort((x, y) => x.sort - y.sort).map((l) => ({ ...l, quantity: Number(l.quantity) })),
    };
  }
  return previous;
}

export async function loadTaxSettings(): Promise<{ taxRate: number; taxRounding: TaxRounding }> {
  const supabase = await createClient();
  const { data } = await supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding"]);
  const settings = new Map((data ?? []).map((s) => [s.key as string, s.value]));
  return {
    taxRate: Number(settings.get("tax_rate") ?? 0.1),
    taxRounding: (settings.get("tax_rounding") ?? "ceil") as TaxRounding,
  };
}

/** 入力フォームに必要なもの：企業の一覧、企業ごとの契約と回数、前回の請求、税率 */
export async function loadBillFormData(excludeBillId?: string) {
  const supabase = await createClient();
  const [{ data: companyData }, contracts, previous, tax] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, send_method, payment_due_months, payment_due_day")
      .eq("is_active", true)
      .order("name"),
    loadContractStates(),
    loadPreviousBills(undefined, excludeBillId),
    loadTaxSettings(),
  ]);
  const contractsByCompany: Record<string, ContractState[]> = {};
  for (const c of contracts) (contractsByCompany[c.company_id] ??= []).push(c);
  return {
    companies: (companyData ?? []) as CompanyOption[],
    contractsByCompany,
    previous,
    ...tax,
  };
}
