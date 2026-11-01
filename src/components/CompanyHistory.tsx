import Link from "next/link";
import type { HistoryEntry } from "@/lib/history";
import { dateLabel, monthLabel, yen } from "@/lib/format";

const RECENT_MONTHS = 6;

/**
 * 企業の請求の履歴（計上月ごと）。状態は「請求済み／未請求」の2つだけ
 *   mode="page"：企業のページ。未請求の月から「新規」
 *   mode="form"：入力フォームの中。今入力している請求はここに出さない
 */
export function CompanyHistory({
  entries,
  companyId,
  mode,
  currentBillId,
  showAll = false,
}: {
  entries: HistoryEntry[];
  companyId: string;
  mode: "page" | "form";
  currentBillId?: string;
  showAll?: boolean; // 「この企業の請求をすべて見る」から来たときは、前の請求も開いておく
}) {
  const list = entries.filter((e) => !(currentBillId && e.bill_id === currentBillId) && !(mode === "form" && e.source === "due"));
  if (list.length === 0) return <p className="muted small">まだ請求の履歴はありません。</p>;

  const months = [...new Set(list.map((e) => e.month))];
  const recent = new Set(months.slice(0, RECENT_MONTHS));
  const head = list.filter((e) => recent.has(e.month));
  const rest = list.filter((e) => !recent.has(e.month));

  const table = (rows: HistoryEntry[]) => (
    <div className="table-wrap">
      <table className="history-table">
        <thead>
          <tr>
            <th>計上月</th>
            <th>内容</th>
            <th className="num">金額（税抜）</th>
            <th>状態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.key} className={e.status === "unbilled" ? "is-unbilled" : undefined}>
              <td className="nowrap">
                {monthLabel(e.month)}
                {e.issue_date && <div className="small muted">請求日 {dateLabel(e.issue_date)}</div>}
              </td>
              <td>
                <ul className="history-lines">
                  {e.lines.map((l, i) => (
                    <li key={i}>
                      {l.description}
                      {e.lines.length > 1 && <span className="muted nowrap">　{yen(l.amount)}</span>}
                    </li>
                  ))}
                </ul>
                <div className="small muted">
                  {e.source === "sheet" && "企業シート（旧Excel）から"}
                  {e.source === "app" && (e.invoice_no ? `アプリで入力・請求書 No ${e.invoice_no}` : "アプリで入力")}
                  {e.source === "due" && "毎月の契約から（まだ入力していません）"}
                </div>
              </td>
              <td className="num nowrap">{yen(e.amount)}</td>
              <td className="nowrap">
                <span className={`status-badge ${e.status === "billed" ? "is-billed" : "is-unbilled"}`}>
                  {e.status === "billed" ? "請求済み" : "未請求"}
                </span>
              </td>
              <td className="nowrap">
                {e.source === "app" && e.bill_id && (
                  <Link href={e.status === "billed" ? `/bills/${e.bill_id}` : `/bills/${e.bill_id}/edit`} className="btn btn-secondary btn-small">
                    開く
                  </Link>
                )}
                {e.source === "due" && (
                  <Link href={`/bills/new?company=${companyId}`} className="btn btn-small">
                    新規
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {table(head)}
      {rest.length > 0 && (
        <details className="history-older" open={showAll}>
          <summary>それより前の請求を見る（{months.length - recent.size}か月ぶん）</summary>
          {table(rest)}
        </details>
      )}
    </>
  );
}
