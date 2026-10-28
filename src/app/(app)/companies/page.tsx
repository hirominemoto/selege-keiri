import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendMethodLabel } from "@/lib/format";

type Row = {
  id: string;
  name: string;
  send_method: string;
  is_active: boolean;
  contracts: { status: string }[];
};

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string; all?: string }> }) {
  const { q, all } = await searchParams;
  const user = await requireUser();
  const supabase = await createClient();

  let query = supabase
    .from("companies")
    .select("id, name, send_method, is_active, contracts(status)")
    .order("name");
  if (!all) query = query.eq("is_active", true);

  const keyword = q?.trim();
  if (keyword) {
    // 旧Excelの表記（「興和工業株式会社1」など）でも探せるようにする
    const { data: aliases } = await supabase.from("company_aliases").select("company_id").ilike("alias", `%${keyword}%`);
    const ids = (aliases ?? []).map((a) => a.company_id);
    const escaped = keyword.replace(/[%,()"\\]/g, "");
    query = ids.length
      ? query.or(`name.ilike."%${escaped}%",id.in.(${ids.join(",")})`)
      : query.ilike("name", `%${escaped}%`);
  }

  const { data, error } = await query;
  const rows = (data ?? []) as Row[];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>企業・契約</h1>
          <p className="lead">取引先の宛名と、契約ごとの金額・回数</p>
        </div>
        {user.role === "admin" && (
          <Link href="/companies/new" className="btn">
            ＋ 企業を登録
          </Link>
        )}
      </div>

      <form className="search" role="search">
        <input type="search" name="q" defaultValue={q ?? ""} placeholder="企業名で探す" aria-label="企業名で探す" />
        {all && <input type="hidden" name="all" value="1" />}
        <button type="submit" className="btn btn-secondary">
          探す
        </button>
        <Link href={all ? "/companies" : "/companies?all=1"} className="btn btn-quiet">
          {all ? "取引中だけ表示" : "取引終了の企業も表示"}
        </Link>
      </form>

      {error && <p className="notice notice-error">読み込めませんでした（{error.message}）</p>}

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">
            {keyword ? `「${keyword}」に当てはまる企業はありません` : "まだ企業が登録されていません"}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>企業名</th>
                <th className="num">継続中の契約</th>
                <th>送り方</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/companies/${r.id}`}>{r.name}</Link>
                  </td>
                  <td className="num">{r.contracts.filter((c) => c.status === "active").length}</td>
                  <td>{sendMethodLabel[r.send_method]}</td>
                  <td>
                    {r.is_active ? <span className="badge badge-active">取引中</span> : <span className="badge">取引終了</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
