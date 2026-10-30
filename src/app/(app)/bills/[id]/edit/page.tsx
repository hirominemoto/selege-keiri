import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BillForm } from "@/components/BillForm";
import { requireUser } from "@/lib/auth";
import { todayJst, type Bill, type BillLine } from "@/lib/bills";
import { createClient } from "@/lib/supabase/server";
import { loadBillFormData } from "../../formData";

export default async function EditBillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (user.role !== "admin") redirect(`/bills/${id}`);

  const supabase = await createClient();
  const [{ data: bill }, { data: lines }, data] = await Promise.all([
    supabase.from("bills").select("*").eq("id", id).maybeSingle(),
    supabase.from("bill_lines").select("*").eq("bill_id", id).order("sort"),
    loadBillFormData(id),
  ]);
  if (!bill) notFound();
  if (bill.status !== "draft") redirect(`/bills/${id}`);

  return (
    <main className="page">
      <nav className="breadcrumb">
        <Link href="/bills">請求の入力</Link> ／ <Link href={`/bills/${id}`}>請求</Link> ／ 直す
      </nav>
      <div className="page-head">
        <div>
          <h1>請求を直す</h1>
          <p className="lead">入力中なので、自由に直せます。</p>
        </div>
      </div>
      <BillForm {...data} defaultStaff={user.displayName ?? ""} today={todayJst()} bill={bill as Bill} lines={(lines ?? []) as BillLine[]} />
    </main>
  );
}
