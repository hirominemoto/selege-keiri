import Link from "next/link";
import { invoiceTotals, type TaxRounding } from "@/lib/billing";
import { contractLabel, isDueThisMonth, serviceMonthOf, type ContractState } from "@/lib/bills";
import { contractKindLabel, countLabel, dateLabel, monthLabel, yen } from "@/lib/format";

/** 企業ごとの前回の請求 */
export type PreviousBill = {
  id: string;
  issue_date: string;
  accounting_month: string;
  invoice_no: string | null;
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
      <h3>契約と回数（{monthLabel(props.accountingMonth)}計上の場合）</h3>
      {live.length === 0 ? (
        <p className="muted small">継続中の契約はありません。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>契約</th>
                <th>前回まで</th>
                <th>今回請求すると</th>
              </tr>
            </thead>
            <tbody>
              {live.map((c) => {
                const svc = serviceMonthOf(c, props.accountingMonth);
                const billed = !!c.last_service_month && svc <= c.last_service_month;
                const due = isDueThisMonth(c, props.accountingMonth);
                const over = c.total_count !== null && c.next_count > c.total_count;
                return (
                  <tr key={c.id}>
                    <td>
                      {contractLabel(c)}
                      <div className="small muted">
                        {contractKindLabel[c.kind]}・{Number(c.quantity)}名 × {yen(c.unit_price)}
                      </div>
                    </td>
                    <td>
                      {c.last_count ? countLabel(c.last_count, c.total_count, c.count_unit) : "—"}
                      {c.last_service_month && <div className="small muted">{monthLabel(c.last_service_month)}分まで</div>}
                    </td>
                    <td>
                      {billed ? (
                        <span className="badge badge-active">{monthLabel(svc)}分は入力済み</span>
                      ) : over ? (
                        <span className="badge">全{c.total_count}回が終わっています</span>
                      ) : (
                        <>
                          {monthLabel(svc)}分・{countLabel(c.next_count, c.total_count, c.count_unit)}
                          {!due && c.kind !== "monthly" && <div className="small muted">請求するときだけ</div>}
                          {!due && c.kind === "monthly" && c.status !== "active" && <div className="small muted">休止中</div>}
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
        <p className="muted small">アプリでの請求はまだありません（旧Excelの分は、上の「前回まで」に出ています）。</p>
      ) : (
        <>
          <p className="small">
            <Link href={`/bills/${prev.id}`}>
              請求日 {dateLabel(prev.issue_date)}（{monthLabel(prev.accounting_month)}計上）
            </Link>
            {prev.invoice_no && <span className="muted">　請求書№ {prev.invoice_no}</span>}
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
