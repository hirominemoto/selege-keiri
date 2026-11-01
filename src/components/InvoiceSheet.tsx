import { invoiceTotals, type Issuer, type TaxRounding, type Totals } from "@/lib/billing";

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
  /** 送付OK以降は、送付OKで固まった金額をそのまま出す（いまの税の設定で計算し直さない） */
  frozenTotals?: Totals;
};

const ROWS = 8; // 旧Excelの請求書と同じ明細8行

const n = (v: number) => v.toLocaleString("ja-JP");
const yenMark = (v: number) => `¥${n(v)}`;
/** "2026-06-30" → "2026/6/30"（旧Excelの請求書と同じ書き方） */
const slashDate = (d: string | null) => {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${Number(y)}/${Number(m)}/${Number(day)}`;
};
const splitLines = (s: string | undefined) => (s ? s.split(/\r?\n/) : []);

/**
 * 請求書1枚（A4）。旧Excelの請求書（売上表の「請求書へ」で作っていたもの）と同じ並び。
 * 画面のプレビューと印刷（PDF保存）で同じものを使う。
 * 金額は表示用の計算。送付OKのときの正式な金額はデータベースで固まる。
 */
export function InvoiceSheet(p: Props) {
  const t = p.frozenTotals ?? invoiceTotals(p.lines, p.taxRate, p.taxRounding);
  const hasNontaxable = t.nontaxable !== 0;
  const blanks = Math.max(0, ROWS - p.lines.length);
  const ratePct = Math.round(p.taxRate * 100);
  const issuerReady = Boolean(p.issuer.name);

  return (
    <div className="invoice-sheet">
      {p.isDraft && <div className="invoice-watermark" aria-hidden="true">下書き</div>}

      <div className="inv-date">
        <div className="inv-underline">
          <span className="inv-date-label">請求日</span>
          <span>{slashDate(p.issueDate)}</span>
        </div>
        <div className="inv-underline inv-regno">{p.issuer.registration_no ?? ""}</div>
      </div>

      <div className="inv-to inv-underline">
        <span className="inv-to-name">{p.billToName}</span>
        <span className="inv-to-honorific">{p.honorific}</span>
      </div>

      <div className="inv-from">
        {issuerReady ? (
          <>
            {p.issuer.postal_code && <div>〒{p.issuer.postal_code}</div>}
            {splitLines(p.issuer.address).map((l, i) => (
              <div key={i}>{l}</div>
            ))}
            {p.issuer.phone && <div>TEL {p.issuer.phone}</div>}
            <div>{p.issuer.name}</div>
          </>
        ) : (
          <div className="invoice-pending">自社の情報（住所・社名・登録番号）は設定待ち</div>
        )}
        {p.issuer.seal ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="inv-seal" src={p.issuer.seal} alt="角印" />
        ) : (
          <div className="inv-seal inv-seal-empty" aria-label="角印">
            角印
          </div>
        )}
      </div>

      <h2 className="inv-title">御請求書</h2>
      <p className="inv-greeting">毎度ありがとうございます。下記の通りご請求申し上げます。</p>

      <div className="inv-amount-label">今回のご請求額</div>
      <div className="inv-amount">
        <div className="inv-amount-inner">
          <span>￥</span>
          <span className="inv-amount-num">{n(t.total)}</span>
          <span>－</span>
        </div>
      </div>

      <table className="inv-lines">
        <thead>
          <tr>
            <th className="c-date">内定日</th>
            <th className="c-desc"></th>
            <th className="c-qty">数量・サイズ</th>
            <th className="c-amount">金　額</th>
            <th className="c-due">支払予定日</th>
          </tr>
        </thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={i}>
              <td className="c-date">-</td>
              <td className="c-desc">
                {l.description}
                {!l.taxable && !l.description.includes("非課税") && "（非課税）"}
              </td>
              <td className="c-qty">{Number(l.quantity)}</td>
              <td className="c-amount">{yenMark(l.amount)}</td>
              <td className="c-due">{slashDate(p.dueDate)}</td>
            </tr>
          ))}
          {Array.from({ length: blanks }).map((_, i) => (
            <tr key={`b${i}`}>
              <td className="c-date">&nbsp;</td>
              <td className="c-desc"></td>
              <td className="c-qty"></td>
              <td className="c-amount"></td>
              <td className="c-due"></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-totals-wrap">
        <div className="inv-taxnote">※税率{ratePct}％</div>
        <table className="inv-totals">
          <tbody>
            {hasNontaxable ? (
              <>
                <tr>
                  <th>{ratePct}％対象</th>
                  <td>{yenMark(t.taxable)}</td>
                </tr>
                <tr>
                  <th>消費税</th>
                  <td>{yenMark(t.tax)}</td>
                </tr>
                <tr>
                  <th>対象外</th>
                  <td>{yenMark(t.nontaxable)}</td>
                </tr>
              </>
            ) : (
              <>
                <tr>
                  <th>小　計</th>
                  <td>{yenMark(t.taxable)}</td>
                </tr>
                <tr>
                  <th>消費税</th>
                  <td>{yenMark(t.tax)}</td>
                </tr>
              </>
            )}
            <tr>
              <th>合　計</th>
              <td>{yenMark(t.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="inv-bank-note">
        ※お手数とは存じますが下記銀行の普通預金口座宛にお振込下さいますようお願い申し上げます。
        <br />
        <span className="inv-indent">尚、振込手数料は御社にて負担して頂きますようお願い申し上げます。</span>
      </p>

      <div className="inv-bottom">
        <div className="inv-bank">
          {p.issuer.bank ? (
            splitLines(p.issuer.bank).map((l, i) => <div key={i}>{l}</div>)
          ) : (
            <div className="invoice-pending">振込先は設定待ち</div>
          )}
        </div>
        <div className="inv-no">
          <span>No</span>
          <span className="inv-no-box">
            {p.invoiceNo ?? <span className="invoice-pending">送付OKで付きます</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
