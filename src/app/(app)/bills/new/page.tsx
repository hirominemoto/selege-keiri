import Link from "next/link";
import { redirect } from "next/navigation";
import { BillForm } from "@/components/BillForm";
import { requireUser } from "@/lib/auth";
import { todayJst } from "@/lib/bills";
import { parseMonth } from "@/lib/billing";
import { currentMonthJst } from "@/lib/dates";
import { loadBillFormData } from "../formData";

export default async function NewBillPage({ searchParams }: { searchParams: Promise<{ company?: string; month?: string }> }) {
  const { company, month } = await searchParams;
  // 前の月などの一覧から来たときは、計上月をその月で始める（今月なら今までどおり請求日の月）
  const m = parseMonth(month);
  const initialMonth = m && m !== currentMonthJst() ? m.slice(0, 7) : undefined;
  const user = await requireUser();
  if (user.role !== "admin") redirect("/bills");
  const data = await loadBillFormData();

  return (
    <main className="page">
      <nav className="breadcrumb">
        <Link href="/bills">請求の入力</Link> ／ 新しい請求
      </nav>
      <div className="page-head">
        <div>
          <h1>新しい請求</h1>
          <p className="lead">1回の入力が、1枚の請求書になります。保存したあとも、請求書を作るまでは何度でも直せます。</p>
        </div>
      </div>
      <BillForm {...data} initialCompanyId={company} initialMonth={initialMonth} today={todayJst()} />
    </main>
  );
}
