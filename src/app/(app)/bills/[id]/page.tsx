import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/InvoiceDraftForms";
import { requireUser } from "@/lib/auth";
import type { TaxRounding } from "@/lib/billing";
import { billStatusText, billTotals, todayJst, type Bill, type BillLine } from "@/lib/bills";
import { dateLabel, dateTimeLabel, monthLabel, sendMethodLabel, yen } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { deleteBill, issueBill, markBillSent, reopenBill } from "../actions";
import { ExcelRowsPreview } from "@/components/ExcelRowsPreview";
import { excelRowsForBill } from "@/lib/excelRows";

export default async function BillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; sent?: string; reopened?: string; error?: string }>;
}) {
  const { id } = await params;
  const { saved, sent, reopened, error } = await searchParams;
  const user = await requireUser();
  const canEdit = user.role === "admin";
  const supabase = await createClient();

  const [{ data: billData }, { data: lineData }, { data: settingData }, { data: revData }] = await Promise.all([
    supabase.from("bills").select("*, companies(name)").eq("id", id).maybeSingle(),
    supabase.from("bill_lines").select("*").eq("bill_id", id).order("sort"),
    supabase.from("app_settings").select("key, value").in("key", ["tax_rate", "tax_rounding"]),
    supabase.from("bill_revisions").select("revision, reason, created_at, snapshot->bill->>total, snapshot->bill->>invoice_no").eq("bill_id", id).order("revision"),
  ]);
  if (!billData) notFound();
  const revisions = (revData ?? []) as unknown as { revision: number; reason: string; created_at: string; total: string | null }[];
  const reworking = billData.status === "draft" && billData.invoice_no !== null;
  const bill = billData as Bill & { companies: { name: string } | null };
  const lines = (lineData ?? []) as BillLine[];
  const settings = new Map((settingData ?? []).map((s) => [s.key as string, s.value]));
  // 請求書を作ったあとは、作ったときの税率（いまの設定が変わっても請求書と合わせる）
  const taxRate =
    billData.tax_rate !== null && billData.tax_rate !== undefined
      ? Number(billData.tax_rate)
      : Number(settings.get("tax_rate") ?? 0.1);
  // 請求書を作ったあとは、作ったときに固まった金額を出す
  const totals = billTotals(bill, lines, taxRate, (settings.get("tax_rounding") ?? "ceil") as TaxRounding);
  const hasNontaxable = totals.nontaxable !== 0;
  const isDraft = bill.status === "draft";
  const { data: sheetRow } = await supabase
    .from("legacy_sheet_rows")
    .select("sheet_name")
    .eq("company_id", bill.company_id)
    .order("issue_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const excelBooks = excelRowsForBill(
    {
      company_name: bill.companies?.name ?? "",
      issue_date: bill.issue_date,
      accounting_month: bill.accounting_month,
      payment_due_date: bill.payment_due_date,
      staff_name: bill.staff_name,
      invoice_no: bill.invoice_no,
      invoice_total: totals.total,
      lines: lines.map((l) => ({ ...l, quantity: Number(l.quantity), note: l.note ?? null })),
    },
    sheetRow?.sheet_name ?? null,
  );

  return (
    <main className="page">
      <nav className="breadcrumb">
        <Link href="/bills">請求の入力</Link> ／ 請求
      </nav>
      <div className="page-head">
        <div>
          <h1>{bill.companies?.name ?? "（企業が見つかりません）"}</h1>
          <p className="lead">
            <span className={`badge ${isDraft ? "" : "badge-active"}`}>{billStatusText(bill)}</span>{" "}
            請求日 {dateLabel(bill.issue_date)}　計上月 {monthLabel(bill.accounting_month)}
          </p>
        </div>
        {canEdit && isDraft && (
          <Link href={`/bills/${bill.id}/edit`} className="btn">
            直す
          </Link>
        )}
      </div>

      {saved && <p className="notice notice-info">保存しました。</p>}
      {sent && <p className="notice notice-info">請求済みにしました。</p>}
      {reopened && <p className="notice notice-info">作り直せるようにしました。「直す」で直してから、もう一度「請求書を作る」を押してください（番号は №{bill.invoice_no} のまま）。</p>}
      {!reopened && reworking && (
        <p className="notice notice-warn">作り直し中です（№{bill.invoice_no}）。直し終わったら、もう一度「請求書を作る」を押してください。</p>
      )}
      {error && <p className="notice notice-error">{error}</p>}

      <div className="card">
        <h2>明細</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>内訳（案件名）</th>
                <th className="num">単価</th>
                <th className="num">個数</th>
                <th className="num">金額（税抜）</th>
                <th>備考</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="bill-desc">
                    {l.description}
                    {!l.taxable && <span className="badge" style={{ marginLeft: 6 }}>消費税なし</span>}
                  </td>
                  <td className="num">{yen(l.unit_price)}</td>
                  <td className="num">{Number(l.quantity)}</td>
                  <td className="num">{yen(l.amount)}</td>
                  <td>{l.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="bill-totals">
          <div>
            <dt>{hasNontaxable ? "10％対象" : "小計"}</dt>
            <dd>{yen(totals.taxable)}</dd>
          </div>
          <div>
            <dt>消費税（{Math.round(taxRate * 100)}％）</dt>
            <dd>{yen(totals.tax)}</dd>
          </div>
          {hasNontaxable && (
            <div>
              <dt>対象外</dt>
              <dd>{yen(totals.nontaxable)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>合計（税込）</dt>
            <dd>{yen(totals.total)}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <h2>Excelにはこう書かれます</h2>
        <p className="small muted">
          この請求を入力すると、3つのExcelにこの行が足されます（見本です。Excelへの書き込みはまだ作っていません）。
        </p>
        <ExcelRowsPreview books={excelBooks} />
      </div>

      <div className="card">
        <h2>請求書全体</h2>
        <dl className="bill-facts">
          <dt>支払期限</dt>
          <dd>{dateLabel(bill.payment_due_date)}</dd>
          <dt>送り方</dt>
          <dd>{sendMethodLabel[bill.send_method]}</dd>
          <dt>担当</dt>
          <dd>{bill.staff_name ?? "—"}</dd>
          {bill.memo && (
            <>
              <dt>社内メモ</dt>
              <dd>{bill.memo}</dd>
            </>
          )}
          <dt>最後の更新</dt>
          <dd>{dateTimeLabel(bill.updated_at)}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>請求書</h2>
        {isDraft && (
          <>
            <p className="muted">
              まだアプリに入力しただけです。「請求書を見る（下書き）」で見え方を確かめてから、「請求書を作る」を押してください。
              押すと番号が付いて、金額が固まります（そのあとはここでは直せません）。
            </p>
            {lines.length > 8 && (
              <p className="notice">
                明細が{lines.length}行あります。請求書は行を詰めて1枚に収めます。「請求書を見る（下書き）」で、いちばん下の請求書番号まで切れずに見えているかを確かめてください（見えたとおりに印刷されます）。
              </p>
            )}
            <div className="form-actions">
              <Link href={`/bills/${bill.id}/invoice`} className="btn btn-secondary">
                請求書を見る（下書き）
              </Link>
              {canEdit && (
                <form action={issueBill}>
                  <input type="hidden" name="id" value={bill.id} />
                  <input type="hidden" name="version" value={bill.version} />
                  <ConfirmButton
                    message={`${bill.companies?.name ?? ""} の請求書を作ります（合計 ${yen(totals.total)}）。番号が付き、このあとは直せなくなります。よろしいですか？`}
                    className="btn"
                  >
                    請求書を作る
                  </ConfirmButton>
                </form>
              )}
            </div>
          </>
        )}
        {!isDraft && (
          <>
            <p className="muted">
              №{bill.invoice_no}　作った日時 {dateTimeLabel(bill.issued_at)}
            </p>
            <div className="form-actions">
              <Link href={`/bills/${bill.id}/invoice`} className="btn btn-secondary">
                請求書を開く（印刷・PDF）
              </Link>
            </div>
          </>
        )}
        {bill.status === "issued" && canEdit && (
          <form action={markBillSent} className="form" style={{ marginTop: 16 }}>
            <input type="hidden" name="id" value={bill.id} />
            <h3>送ったら</h3>
            <div className="form-row">
              <label>
                送った日
                <input name="sent_on" type="date" defaultValue={todayJst()} required />
              </label>
              <fieldset className="choices">
                <legend>送り方</legend>
                <label className="choice">
                  <input type="radio" name="send_method" value="post" defaultChecked={bill.send_method === "post"} />
                  郵送
                </label>
                <label className="choice">
                  <input type="radio" name="send_method" value="email" defaultChecked={bill.send_method === "email"} />
                  メール
                </label>
              </fieldset>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn">
                送った（請求済みにする）
              </button>
            </div>
          </form>
        )}
      </div>

      {canEdit && !isDraft && (
        <div className="card">
          <h2>作り直す</h2>
          <p className="muted">
            請求書を作ったあとに間違いに気づいたときに使います。理由を書いて押すと「入力中」に戻り、「直す」で直せるようになります。
            番号（№{bill.invoice_no}）はそのままで、いまの請求書は「前の版」として残ります。直したら、もう一度「請求書を作る」を押してください。
          </p>
          <form action={reopenBill} className="form">
            <input type="hidden" name="id" value={bill.id} />
            <label>
              作り直す理由
              <textarea name="reason" rows={2} required placeholder="例：内訳の月を間違えた" />
            </label>
            <div className="form-actions">
              <ConfirmButton message={`№${bill.invoice_no} の請求書を作り直します。よろしいですか？（番号はそのまま。いまの請求書は前の版として残ります）`} className="btn btn-secondary">
                作り直す
              </ConfirmButton>
            </div>
          </form>
        </div>
      )}

      {revisions.length > 0 && (
        <div className="card">
          <h2>前の版</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>版</th>
                  <th>作り直した日時</th>
                  <th>理由</th>
                  <th className="num">そのときの合計（税込）</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.revision}>
                    <td>{r.revision === 1 ? "最初の請求書" : `${r.revision}枚目`}</td>
                    <td>{dateTimeLabel(r.created_at)}</td>
                    <td className="bill-desc">{r.reason}</td>
                    <td className="num">{r.total ? yen(Number(r.total)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canEdit && isDraft && !reworking && (
        <div className="card">
          <h2>このあと</h2>
          <p className="muted">「Excelに書き込む」（企業シート・売上表・収支一覧への記入）は、次の段階で作ります。</p>
          <form action={deleteBill} className="form-actions">
            <input type="hidden" name="id" value={bill.id} />
            <ConfirmButton message="この請求を消します。よろしいですか？（まだ請求書を作っていないので、請求書番号は使われません）" className="btn btn-danger-quiet">
              この請求を消す
            </ConfirmButton>
          </form>
        </div>
      )}
    </main>
  );
}
