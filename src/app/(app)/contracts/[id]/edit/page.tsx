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

  const { count } = await supabase
    .from("billing_requests")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", id)
    .in("status", ["confirmed", "invoiced"]);

  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ <Link href={`/companies/${company.id}`}>{company.name}</Link> ／
        契約の変更
      </div>
      <div className="page-head">
        <h1>契約の変更</h1>
      </div>
      {(count ?? 0) > 0 && (
        <p className="notice notice-warn" style={{ marginBottom: 16 }}>
          この契約は、アプリで {count} 回請求を確定しています。変更は次の請求から使われ、確定済みの請求は変わりません。
        </p>
      )}
      <ContractForm
        companyId={company.id}
        companyName={company.name}
        contract={contract}
        confirmedInApp={count ?? 0}
        exampleMonth={currentMonthJst()}
      />
    </main>
  );
}
