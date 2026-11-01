import Link from "next/link";
import { redirect } from "next/navigation";
import { LegacyImportForm } from "@/components/LegacyImportForm";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default async function ImportSheetPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/companies");
  const supabase = await createClient();
  const [{ data: companies }, { data: aliases }, { count }] = await Promise.all([
    supabase.from("companies").select("id, name").order("name"),
    supabase.from("company_aliases").select("company_id, alias"),
    supabase.from("legacy_sheet_rows").select("id", { count: "exact", head: true }),
  ]);
  const aliasMap = new Map<string, string[]>();
  for (const a of aliases ?? []) aliasMap.set(a.company_id, [...(aliasMap.get(a.company_id) ?? []), a.alias]);

  return (
    <main className="page">
      <nav className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ 企業シートの取り込み
      </nav>
      <div className="page-head">
        <div>
          <h1>企業シートの取り込み（最初に1回だけ）</h1>
          <p className="lead">
            10/31 までの請求を、旧Excelの企業シートからアプリに取り込みます。取り込んだ行は、入力フォームの「請求の履歴」に「請求済み」として出ます。
            11月からの請求はアプリで入力するので、ふだんはこの画面を使いません。
          </p>
        </div>
      </div>
      <LegacyImportForm
        companies={(companies ?? []).map((c) => ({ id: c.id, name: c.name, aliases: aliasMap.get(c.id) ?? [] }))}
        alreadyImported={count ?? 0}
      />
    </main>
  );
}
