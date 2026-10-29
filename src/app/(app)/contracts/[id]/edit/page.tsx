import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ContractForm } from "@/components/ContractForm";
import { requireUser } from "@/lib/auth";
import { currentMonthJst } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";
import type { Contract } from "@/lib/types";

export default async function EditContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("contracts").select("*, companies(id, name)").eq("id", id).maybeSingle();
  if (!data) notFound();
  const { companies: company, ...rest } = data as Contract & { companies: { id: string; name: string } };
  const contract = rest as Contract;

  const user = await requireUser();
  if (user.role !== "admin") redirect(`/companies/${company.id}`);

  // アプリでの請求（取消を除く通常の依頼）の件数と、最大の回数
  const { data: reqs } = await supabase
    .from("billing_requests")
    .select("count_no")
    .eq("contract_id", id)
    .eq("kind", "normal")
    .eq("status", "active");
  const count = reqs?.length ?? 0;
  const maxCount = (reqs ?? []).reduce<number | null>(
    (m, r) => (r.count_no !== null && (m === null || r.count_no > m) ? r.count_no : m),
    null,
  );

  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ <Link href={`/companies/${company.id}`}>{company.name}</Link> ／
        契約の変更
      </div>
      <div className="page-head">
        <h1>契約の変更</h1>
      </div>
      {count > 0 && (
        <p className="notice notice-warn" style={{ marginBottom: 16 }}>
          この契約は、アプリで {count} 件の請求があります。変更はこれから作る請求から使われ、作成済みの請求は変わりません。
        </p>
      )}
      <ContractForm
        companyId={company.id}
        companyName={company.name}
        contract={contract}
        maxCountInApp={maxCount}
        exampleMonth={currentMonthJst()}
      />
    </main>
  );
}
