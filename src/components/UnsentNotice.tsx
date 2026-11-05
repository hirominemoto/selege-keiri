import Link from "next/link";
import { currentMonthJst } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

/**
 * まだ送っていない請求（請求書を作って、まだ「送った」を押していないもの）を、月に関係なく数えて出す。
 * 前の月の計上で足した請求の送り漏れに気づけるように、ホームと「請求の入力」のいちばん上に置く。
 * 1件もないときは何も出さない。
 */
export async function UnsentNotice() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("bills").select("accounting_month").eq("status", "issued");
  if (error || !data || data.length === 0) return null;

  const byMonth = new Map<string, number>();
  for (const r of data as { accounting_month: string }[]) {
    byMonth.set(r.accounting_month, (byMonth.get(r.accounting_month) ?? 0) + 1);
  }
  const thisYear = currentMonthJst().slice(0, 4);
  const parts = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, n]) => {
      const [y, mm] = m.split("-");
      const label = y === thisYear ? `${Number(mm)}月` : `${Number(y)}年${Number(mm)}月`;
      return `${label}：${n}件`;
    });

  return (
    <Link href="/bills?show=unsent" className="notice notice-warn unsent-notice">
      まだ送っていない請求が<strong>{data.length}件</strong>あります（{parts.join("・")}）
      <span className="unsent-more">押すと一覧を表示</span>
    </Link>
  );
}
