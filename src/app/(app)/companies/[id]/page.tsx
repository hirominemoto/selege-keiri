import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { monthName, nextCount } from "@/lib/contract";
import { currentMonthJst } from "@/lib/dates";
import {
  contractKindLabel,
  contractStatusLabel,
  countLabel,
  dateTimeLabel,
  monthLabel,
  sendMethodLabel,
  yen,
} from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Company, Contract } from "@/lib/types";

type AuditRow = {
  id: number;
  table_name: string;
  action: string;
  at: string;
  actor: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
};

const fieldLabels: Record<string, string> = {
  name: "名前",
  honorific: "敬称",
  postal_code: "郵便番号",
  address1: "住所",
  address2: "住所（建物）",
  department: "部署",
  contact_name: "担当者",
  phone: "電話",
  email: "メール",
  send_method: "送り方",
  payment_due_months: "入金予定（月）",
  payment_due_day: "入金予定（日）",
  is_active: "取引の状態",
  cohort: "期",
  kind: "請求のしかた",
  quantity: "人数・個数",
  unit_price: "単価",
  taxable: "消費税",
  service_month_offset: "◯月分の関係",
  total_count: "全回数",
  count_unit: "数え方",
  base_count: "請求済みの回数",
  start_month: "開始月",
  end_month: "終了月",
  status: "状態",
  description_template: "品名のひな形",
  note: "メモ",
};
const skip = new Set(["version", "updated_at", "updated_by", "created_at", "created_by", "id", "company_id"]);

function changedFields(a: AuditRow): string {
  if (a.action === "INSERT") return "登録";
  if (a.action === "DELETE") return "削除";
  const o = a.old_data ?? {};
  const n = a.new_data ?? {};
  const keys = Object.keys(n).filter((k) => !skip.has(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
  return keys.length ? keys.map((k) => fieldLabels[k] ?? k).join("・") + "を変更" : "変更";
}

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();

  const { data: companyData } = await supabase.from("companies").select("*").eq("id", id).maybeSingle();
  if (!companyData) notFound();
  const company = companyData as Company;

  const [{ data: contractData }, { data: requestData }, { data: aliasData }] = await Promise.all([
    supabase.from("contracts").select("*").eq("company_id", id).order("status").order("name").order("cohort"),
    supabase
      .from("billing_requests")
      .select("contract_id, count_no")
      .eq("company_id", id)
      .eq("kind", "normal")
      .eq("status", "active"),
    supabase.from("company_aliases").select("alias").eq("company_id", id).order("alias"),
  ]);
  const contracts = (contractData ?? []) as Contract[];
  // 契約ごとの、アプリで請求した最大の回数
  const maxCount = new Map<string, number>();
  for (const r of requestData ?? []) {
    if (r.contract_id && r.count_no !== null) {
      maxCount.set(r.contract_id, Math.max(maxCount.get(r.contract_id) ?? 0, r.count_no));
    }
  }

  // 変更履歴（管理者だけ見られる）
  let audits: AuditRow[] = [];
  const actorNames = new Map<string, string>();
  if (user.role === "admin") {
    const ids = [id, ...contracts.map((c) => c.id)];
    const { data } = await supabase
      .from("audit_log")
      .select("id, table_name, action, at, actor, old_data, new_data")
      .in("table_name", ["companies", "contracts"])
      .in("row_id", ids)
      .order("at", { ascending: false })
      .limit(15);
    audits = (data ?? []) as AuditRow[];
    const actorIds = [...new Set(audits.map((a) => a.actor).filter(Boolean))] as string[];
    if (actorIds.length) {
      const { data: profiles } = await supabase.from("profiles").select("id, email, display_name").in("id", actorIds);
      for (const p of profiles ?? []) actorNames.set(p.id, p.display_name ?? p.email ?? "");
    }
  }

  const thisMonth = currentMonthJst();
  const contractName = (cid: string | null) => {
    const c = contracts.find((x) => x.id === cid);
    return c ? `${c.name}${c.cohort ? `（${c.cohort}）` : ""}` : "";
  };

  const due =
    `請求月の${company.payment_due_months === 0 ? "当月" : company.payment_due_months === 1 ? "翌月" : `${company.payment_due_months}か月後`}` +
    (company.payment_due_day ? `${company.payment_due_day}日` : "末");

  return (
    <main className="page">
      <div className="breadcrumb">
        <Link href="/companies">企業・契約</Link> ／ {company.name}
      </div>
      <div className="page-head">
        <div>
          <h1>
            {company.name} {!company.is_active && <span className="badge">取引終了</span>}
          </h1>
        </div>
        {user.role === "admin" && (
          <Link href={`/companies/${id}/edit`} className="btn btn-secondary">
            企業の情報を変更
          </Link>
        )}
      </div>

      <section className="card">
        <h2>宛名と送り方</h2>
        <dl className="fields">
          <dt>宛名</dt>
          <dd>
            {company.name} {company.honorific}
            {company.department && <div>{company.department}</div>}
            {company.contact_name && <div>{company.contact_name} 様</div>}
          </dd>
          <dt>住所</dt>
          <dd>
            {company.postal_code ? `〒${company.postal_code}` : <span className="muted">郵便番号なし</span>}
            <div>{company.address1 ?? <span className="muted">住所なし</span>}</div>
            {company.address2 && <div>{company.address2}</div>}
          </dd>
          <dt>電話</dt>
          <dd>{company.phone ?? "—"}</dd>
          <dt>いつもの送り方</dt>
          <dd>
            {sendMethodLabel[company.send_method]}
            {company.email && <span className="muted">（{company.email}）</span>}
          </dd>
          <dt>入金予定</dt>
          <dd>{due}</dd>
          {aliasData && aliasData.length > 0 && (
            <>
              <dt>旧Excelでの表記</dt>
              <dd>{aliasData.map((a) => a.alias).join("、")}</dd>
            </>
          )}
          {company.note && (
            <>
              <dt>メモ</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{company.note}</dd>
            </>
          )}
        </dl>
      </section>

      <section style={{ marginTop: 24 }}>
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>契約</h2>
          {user.role === "admin" && (
            <Link href={`/companies/${id}/contracts/new`} className="btn">
              ＋ 契約を追加
            </Link>
          )}
        </div>
        <div className="table-wrap">
          {contracts.length === 0 ? (
            <div className="empty">まだ契約が登録されていません</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>契約</th>
                  <th className="num">人数</th>
                  <th className="num">単価（税抜）</th>
                  <th className="num">月額（税抜）</th>
                  <th>消費税</th>
                  <th>今月請求すると</th>
                  <th>状態</th>
                  {user.role === "admin" && <th></th>}
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => {
                  const n = nextCount(c.base_count, maxCount.get(c.id) ?? null);
                  const over = c.total_count !== null && n > c.total_count;
                  return (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.cohort && <span className="muted">（{c.cohort}）</span>}
                        <div className="small muted">{contractKindLabel[c.kind]}</div>
                      </td>
                      <td className="num">{Number(c.quantity)}</td>
                      <td className="num">{yen(c.unit_price)}</td>
                      <td className="num">{yen(Math.round(Number(c.quantity) * c.unit_price))}</td>
                      <td>{c.taxable ? "かかる" : "かからない"}</td>
                      <td>
                        {monthName(thisMonth, c.service_month_offset)}分・{countLabel(n, c.total_count, c.count_unit)}
                        {over && (
                          <div>
                            <span className="badge badge-warn">全回数を超えます</span>
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge${c.status === "active" ? " badge-active" : ""}`}>
                          {contractStatusLabel[c.status]}
                        </span>
                        {c.end_month && <div className="small muted">〜{monthLabel(c.end_month)}</div>}
                      </td>
                      {user.role === "admin" && (
                        <td>
                          <Link href={`/contracts/${c.id}/edit`}>変更</Link>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {user.role === "admin" && (
        <section style={{ marginTop: 24 }}>
          <h2>変更履歴</h2>
          <div className="table-wrap">
            {audits.length === 0 ? (
              <div className="empty">履歴はまだありません</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>日時</th>
                    <th>だれが</th>
                    <th>何を</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map((a) => (
                    <tr key={a.id}>
                      <td className="small">{dateTimeLabel(a.at)}</td>
                      <td className="small">{(a.actor && actorNames.get(a.actor)) || "—"}</td>
                      <td className="small">
                        {a.table_name === "contracts" ? `契約「${contractName((a.new_data ?? a.old_data)?.id as string)}」` : "企業"}
                        ：{changedFields(a)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
