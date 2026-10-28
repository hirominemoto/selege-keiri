import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ContractForm } from "@/components/ContractForm";
import { requireUser } from "@/lib/auth";
import { currentMonthJst } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";

export default async function NewContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (user.role !== "admin") redirect(`/companies/${id}`);

  const supabase = await createClient();
  const { data: company } = await supabase.from("companies").select("id, name").eq("id", id).maybeSingle();
  if (!company) notFound();

  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ <Link href={`/companies/${id}`}>{company.name}</Link> ／ 契約を追加
      </div>
      <div className="page-head">
        <h1>契約を追加</h1>
      </div>
      <ContractForm companyId={company.id} companyName={company.name} exampleMonth={currentMonthJst()} />
    </main>
  );
}
