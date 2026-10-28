import Link from "next/link";
import { redirect } from "next/navigation";
import { CompanyForm } from "@/components/CompanyForm";
import { requireUser } from "@/lib/auth";

export default async function NewCompanyPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/companies");
  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ 新しい企業
      </div>
      <div className="page-head">
        <h1>企業を登録</h1>
      </div>
      <CompanyForm />
    </main>
  );
}
