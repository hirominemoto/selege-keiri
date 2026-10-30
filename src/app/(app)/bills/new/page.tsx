import Link from "next/link";
import { redirect } from "next/navigation";
import { BillForm } from "@/components/BillForm";
import { requireUser } from "@/lib/auth";
import { todayJst } from "@/lib/bills";
import { loadBillFormData } from "../formData";

export default async function NewBillPage() {
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
      <BillForm {...data} defaultStaff={user.displayName ?? ""} today={todayJst()} />
    </main>
  );
}
