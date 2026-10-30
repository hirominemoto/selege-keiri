import Link from "next/link";
import { invoiceTotals, type TaxRounding } from "@/lib/billing";
import { billStatusText, type BillStatus, contractLabel, serviceMonthOf, type ContractState } from "@/lib/bills";
import { contractKindLabel, countLabel, dateLabel, monthLabel, yen } from "@/lib/format";

/** 企業ごとの前回の請求 */
export type PreviousBill = {
  id: string;
  issue_date: string;
  accounting_month: string;
  invoice_no: string | null;
  status: BillStatus;
  sent_on: string | null;
  send_method: "post" | "email";
  lines: { description: string; unit_price: number; quantity: number; amount: number; taxable: boolean }[];
};

/**
 * 企業の請求状況：契約ごとの回数（前回・今回）と、前回の請求の中身。
 * 企業のページと入力フォームの両方で使う（画面だけの部品。データは呼ぶ側で用意する）
 */
export function CompanyBillingPanel(props: {
  contracts: ContractState[];
  previous?: PreviousBill;
  accountingMonth: string; // 今回の計上月 "2026-11-01"
  taxRate: number;
  taxRounding: TaxRounding;
}) {
  const live = props.contracts.filter((c) => c.status !== "ended");
  const prev = props.previous;
  const prevTotal = prev ? invoiceTotals(prev.lines, props.taxRate, props.taxRounding).total : 0;

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

      <h3>前回の請求</h3>
      {!prev ? (
        <p className="muted small">アプリに入力した請求はまだありません（旧Excelの分は、上の「これまで」に出ています）。</p>
      ) : (
        <>
          <p className="small">
            <Link href={`/bills/${prev.id}`}>
              請求日 {dateLabel(prev.issue_date)}（{monthLabel(prev.accounting_month)}計上）
            </Link>
            <span className="muted">　{billStatusText(prev)}</span>
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>内訳</th>
                  <th className="num">単価</th>
                  <th className="num">個数</th>
                  <th className="num">金額（税抜）</th>
                </tr>
              </thead>
              <tbody>
                {prev.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.description}
                      {!l.taxable && <span className="badge" style={{ marginLeft: 6 }}>消費税なし</span>}
                    </td>
                    <td className="num">{yen(l.unit_price)}</td>
                    <td className="num">{Number(l.quantity)}</td>
                    <td className="num">{yen(l.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="num">
                    合計（税込）
                  </td>
                  <td className="num">
                    <strong>{yen(prevTotal)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
