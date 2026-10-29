import { invoiceTotals, type Issuer, type TaxRounding } from "@/lib/billing";
import { dateLabel } from "@/lib/format";

export type SheetLine = {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
};

type Props = {
  issuer: Issuer;
  billToName: string;
  honorific: string;
  invoiceNo: string | null; // 下書きのあいだは null
  issueDate: string | null;
  dueDate: string | null;
  lines: SheetLine[];
  taxRate: number;
  taxRounding: TaxRounding;
  isDraft: boolean;
};

const ROWS = 8; // 旧Excelの請求書と同じ明細8行

const n = (v: number) => v.toLocaleString("ja-JP");

/**
 * 請求書1枚（A4）。画面のプレビューと印刷（PDF保存）で同じものを使う。
 * 金額は表示用の計算。送付OKのときの正式な金額はデータベースで固まる。
 */
export function InvoiceSheet(p: Props) {
  const t = invoiceTotals(p.lines, p.taxRate, p.taxRounding);
  const hasNontaxable = t.nontaxable !== 0;
  const blanks = Math.max(0, ROWS - p.lines.length);
  const ratePct = Math.round(p.taxRate * 100);
  const issuerReady = Boolean(p.issuer.name);

  return (
    <div className="invoice-sheet">
      {p.isDraft && <div className="invoice-watermark" aria-hidden="true">下書き</div>}

      <h2 className="invoice-title">請 求 書</h2>

      <div className="invoice-meta">
        <div>請求書番号：{p.invoiceNo ?? <span className="invoice-pending">送付OKで自動で付きます</span>}</div>
        <div>請求日：{p.issueDate ? dateLabel(p.issueDate) : "—"}</div>
      </div>

      <div className="invoice-head">
        <div className="invoice-to">
          <div className="invoice-to-name">
            {p.billToName}
            <span className="invoice-honorific">{p.honorific}</span>
          </div>
          <p className="invoice-greeting">下記のとおりご請求申し上げます。</p>
          <div className="invoice-amount">
            <span>ご請求金額</span>
            <strong>￥{n(t.total)}－</strong>
            <span className="invoice-amount-note">（税込）</span>
          </div>
          <div className="invoice-due">お支払期限：{p.dueDate ? dateLabel(p.dueDate) : "—"}</div>
        </div>

        <div className="invoice-from">
          {issuerReady ? (
            <>
              <div className="invoice-from-name">{p.issuer.name}</div>
              {p.issuer.postal_code && <div>〒{p.issuer.postal_code}</div>}
              {p.issuer.address && <div>{p.issuer.address}</div>}
              {p.issuer.phone && <div>TEL {p.issuer.phone}</div>}
              {p.issuer.registration_no && <div>登録番号 {p.issuer.registration_no}</div>}
            </>
          ) : (
            <div className="invoice-pending">自社の情報（社名・住所・登録番号）は設定待ち</div>
          )}
          <div className="invoice-seal" aria-label="角印">
            角印
          </div>
        </div>
      </div>

      <table className="invoice-lines">
        <thead>
          <tr>
            <th className="col-desc">品名</th>
            <th className="col-date">内定日</th>
            <th className="col-qty">数量</th>
            <th className="col-price">単価</th>
            <th className="col-amount">金額</th>
          </tr>
        </thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={i}>
              <td className="col-desc">
                {l.description}
                {!l.taxable && !l.description.includes("非課税") && <span className="invoice-nontax">（非課税）</span>}
              </td>
              <td className="col-date">－</td>
              <td className="col-qty">{Number(l.quantity)}</td>
              <td className="col-price">{n(l.unit_price)}</td>
              <td className="col-amount">{n(l.amount)}</td>
            </tr>
          ))}
          {Array.from({ length: blanks }).map((_, i) => (
            <tr key={`b${i}`} className="is-blank">
              <td className="col-desc">&nbsp;</td>
              <td className="col-date"></td>
              <td className="col-qty"></td>
              <td className="col-price"></td>
              <td className="col-amount"></td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="invoice-totals">
        <tbody>
          {hasNontaxable ? (
            <>
              <tr>
                <th>{ratePct}％対象</th>
                <td>{n(t.taxable)}</td>
              </tr>
              <tr>
                <th>消費税（{ratePct}％）</th>
                <td>{n(t.tax)}</td>
              </tr>
              <tr>
                <th>対象外</th>
                <td>{n(t.nontaxable)}</td>
              </tr>
            </>
          ) : (
            <>
              <tr>
                <th>小計</th>
                <td>{n(t.taxable)}</td>
              </tr>
              <tr>
                <th>消費税（{ratePct}％）</th>
                <td>{n(t.tax)}</td>
              </tr>
            </>
          )}
          <tr className="invoice-grand">
            <th>合計</th>
            <td>{n(t.total)}</td>
          </tr>
        </tbody>
      </table>

      <div className="invoice-bank">
        <div className="invoice-bank-label">お振込先</div>
        <div>{p.issuer.bank ?? <span className="invoice-pending">振込先は設定待ち</span>}</div>
      </div>
    </div>
  );
}
