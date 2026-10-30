import type { TaxRounding } from "@/lib/billing";
import type { CompanyOption, PreviousBill } from "@/components/BillForm";
import { createClient } from "@/lib/supabase/server";

/** 入力フォームに必要なもの：企業の一覧、企業ごとの前回の請求、税率 */
export async function loadBillFormData(excludeBillId?: string) {
  const supabase = await createClient();
  const [{ data: companyData }, { data: billData }, { data: settingData }] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, send_method, payment_due_months, payment_due_day")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("bills")
      .select("id, company_id, issue_date, created_at, bill_lines(description, sort)")
      .order("issue_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding"]),
  ]);

  const previous: Record<string, PreviousBill> = {};
  for (const b of billData ?? []) {
    if (b.id === excludeBillId || previous[b.company_id]) continue;
    const lines = [...(b.bill_lines ?? [])].sort((x, y) => x.sort - y.sort);
    previous[b.company_id] = { issue_date: b.issue_date, descriptions: lines.map((l) => l.description) };
  }

  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  return {
    companies: (companyData ?? []) as CompanyOption[],
    previous,
    taxRate: Number(settings.get("tax_rate") ?? 0.1),
    taxRounding: (settings.get("tax_rounding") ?? "ceil") as TaxRounding,
  };
}
