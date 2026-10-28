import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CompanyForm } from "@/components/CompanyForm";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Company } from "@/lib/types";

export default async function EditCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (user.role !== "admin") redirect(`/companies/${id}`);

  const supabase = await createClient();
  const { data } = await supabase.from("companies").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const company = data as Company;

  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ <Link href={`/companies/${id}`}>{company.name}</Link> ／ 編集
      </div>
      <div className="page-head">
        <h1>企業の情報を変更</h1>
      </div>
      <CompanyForm company={company} />
    </main>
  );
}
