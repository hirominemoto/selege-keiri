import Link from "next/link";
import { billStatusText, contractLabel, serviceMonthOf, type ContractState } from "@/lib/bills";
import { contractKindLabel, countLabel, monthLabel, yen } from "@/lib/format";

/**
 * 企業の請求状況：契約ごとの回数（前回・今回）。過去の請求の中身は「請求の履歴」（CompanyHistory）に出す。
 * 企業のページと入力フォームの両方で使う（画面だけの部品。データは呼ぶ側で用意する）
 */
export function CompanyBillingPanel(props: {
  contracts: ContractState[];
  accountingMonth: string; // 今回の計上月 "2026-11-01"
}) {
  const live = props.contracts.filter((c) => c.status !== "ended");

  return (
    <div className="billing-panel">
      <h3>契約と回数</h3>
      {live.length === 0 ? (
        <p className="muted small">継続中の契約はありません。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>契約</th>
                <th>これまで</th>
                <th>{monthLabel(props.accountingMonth)}計上で請求すると</th>
              </tr>
            </thead>
            <tbody>
              {live.map((c) => {
                const svc = serviceMonthOf(c, props.accountingMonth);
                const inApp = c.app_entries.find((e) => e.service_month === svc);
                const inSheet = !!c.legacy_last_service_month && svc <= c.legacy_last_service_month;
                const over = c.total_count !== null && c.next_count > c.total_count;
                const recent = c.app_entries.slice(0, 3);
                return (
                  <tr key={c.id}>
                    <td>
                      {contractLabel(c)}
                      <div className="small muted">
                        {contractKindLabel[c.kind]}・{Number(c.quantity)}名 × {yen(c.unit_price)}
                      </div>
                    </td>
                    <td>
                      {recent.map((e) => (
                        <div key={`${e.bill_id}-${e.service_month}`}>
                          {monthLabel(e.service_month)}分{e.count_no ? `・${e.count_no}回目` : ""}：
                          <Link href={`/bills/${e.bill_id}`}>{billStatusText(e)}</Link>
                        </div>
                      ))}
                      {(c.legacy_last_service_month || c.base_count > 0) && (
                        <div className={recent.length ? "small muted" : undefined}>
                          {c.legacy_last_service_month ? `${monthLabel(c.legacy_last_service_month)}分` : ""}
                          {c.base_count > 0 ? `・${countLabel(c.base_count, c.total_count, c.count_unit)}` : ""}
                          まで：企業シートに記入済み（旧Excel）
                        </div>
                      )}
                      {recent.length === 0 && !c.legacy_last_service_month && c.base_count === 0 && "—"}
                    </td>
                    <td>
                      {inApp ? (
                        <span className="badge badge-active">
                          {monthLabel(svc)}分は{billStatusText(inApp)}
                        </span>
                      ) : inSheet ? (
                        <span className="badge">{monthLabel(svc)}分は企業シートに記入済み（旧Excel）</span>
                      ) : over ? (
                        <span className="badge">全{c.total_count}回が終わっています</span>
                      ) : (
                        <>
                          {monthLabel(svc)}分・{countLabel(c.next_count, c.total_count, c.count_unit)}
                          {c.kind !== "monthly" && <div className="small muted">請求するときだけ</div>}
                          {c.kind === "monthly" && c.status !== "active" && <div className="small muted">休止中</div>}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
