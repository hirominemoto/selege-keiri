"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markExcelWritten, unmarkExcelWritten, type WrittenItem } from "@/app/(app)/excel/actions";
import { ConfirmButton } from "@/components/InvoiceDraftForms";
import { dateTimeLabel, yen } from "@/lib/format";
import { readWorkbook, type SheetData } from "@/lib/xlsx";
import { appendRows, colNumber, type SheetWritten, type WriteRow } from "@/lib/xlsxWrite";
import { LEDGER_SHEET } from "@/lib/excelRows";
import { isCompanySheet, planCompanySheets, type CompanySheetBill } from "@/lib/companySheet";

export type ExcelWriteItem = {
  billId: string;
  /** 書く行を作ったときの「請求書を作った日時」。記録するときに、そのあと作り直されていないかを確かめる */
  issuedAt: string;
  invoiceNo: string;
  company: string;
  total: number;
  lineCount: number;
  /** 売上表・収支一覧に書く行（企業シートは、ファイルを読んでから companyBill で作る） */
  rows: WriteRow[];
  /** 企業シートに書く請求の中身（どのシートの何行目かは、ファイルを読んでから決まる） */
  companyBill?: CompanySheetBill;
  /** ファイルにもう書いてあるかを見分ける目印：列 → 1行目の値 */
  marks: Record<string, string | number>;
  written: { sheet: string; firstRow: number; lastRow: number; fileName: string | null; at: string } | null;
  reissuedAfterWrite: boolean;
};

type Prepared = {
  fileName: string;
  data: Uint8Array;
  ranges: SheetWritten[];
  items: WrittenItem[];
  inFile: ExcelWriteItem[]; // ファイルにもう書いてあったので、書かなかったもの
  noSheet: ExcelWriteItem[]; // 企業シートに、その企業のシートがなかったもの
};

const rangeLabel = (w: SheetWritten, withSheet: boolean) =>
  `${withSheet ? `「${w.sheet}」` : ""}${w.firstRow}${w.lastRow !== w.firstRow ? `〜${w.lastRow}` : ""}行目`;

/** そのシートに、目印どおりの行がもうあるか */
function alreadyInSheet(sheet: SheetData, marks: Record<string, string | number>): boolean {
  const cols = Object.entries(marks).map(([c, v]) => [colNumber(c), String(v).trim()] as const);
  if (cols.length === 0) return false;
  for (const row of sheet.rows.values()) {
    if (cols.every(([c, v]) => String(row.get(c) ?? "").trim() === v)) return true;
  }
  return false;
}

/** 1つのブック（売上表・収支一覧・企業シート）への記入 */
export function ExcelWriteForm(props: {
  book: "sales" | "ledger" | "company";
  title: string;
  sheet: string;
  hint: string;
  items: ExcelWriteItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, startSaving] = useTransition();
  const [inputKey, setInputKey] = useState(0);

  const notYet = props.items.filter((i) => !i.written);

  async function onFile(file: File | undefined) {
    setPrepared(null);
    setError(null);
    setDone(null);
    if (!file) return;
    setReading(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const sheets = await readWorkbook(buf);
      const names = sheets.map((s) => s.name);
      const isLedger = names.includes(LEDGER_SHEET);
      const isCompanyBook = sheets.some(isCompanySheet);
      if (props.book !== "ledger" && isLedger) throw new Error(`これは収支一覧のファイルのようです。${props.title}のファイルを選んでください`);
      if (props.book !== "company" && isCompanyBook) throw new Error(`これは企業シートのファイルのようです。${props.title}のファイルを選んでください`);
      if (props.book === "ledger" && !isLedger) throw new Error(`「${LEDGER_SHEET}」シートがありません。収支一覧のファイルを選んでください`);

      if (props.book === "company") {
        if (!isCompanyBook) throw new Error("企業ごとのシートが見つかりません。企業シートのファイルを選んでください");
        const { inFile, noSheet, plan } = planCompanySheets(sheets, notYet);
        if (plan.length === 0) {
          setPrepared({ fileName: file.name, data: buf, ranges: [], items: [], inFile, noSheet });
          return;
        }
        const { data, written } = await appendRows(buf, plan.map((p) => p.edit));
        const items: WrittenItem[] = plan.flatMap((p, k) => {
          let r = written[k].firstRow;
          return p.items.map(({ item, rowCount }) => {
            const it = { bill_id: item.billId, issued_at: item.issuedAt, sheet: p.edit.sheet, first_row: r, last_row: r + rowCount - 1 };
            r += rowCount;
            return it;
          });
        });
        setPrepared({ fileName: file.name, data, ranges: written, items, inFile, noSheet });
        return;
      }

      const target = sheets.find((s) => s.name === props.sheet);
      if (!target) throw new Error(`「${props.sheet}」シートがありません。${props.title}のファイルか確かめてください`);

      const inFile = notYet.filter((i) => alreadyInSheet(target, i.marks));
      const toWrite = notYet.filter((i) => !inFile.includes(i));
      if (toWrite.length === 0) {
        setPrepared({ fileName: file.name, data: buf, ranges: [], items: [], inFile, noSheet: [] });
        return;
      }
      const rows = toWrite.flatMap((i) => i.rows);
      const { data, written } = await appendRows(buf, [{ sheet: props.sheet, startRow: 2, keyCol: "B", rows }]);
      const firstRow = written[0].firstRow;
      let r = firstRow;
      const items: WrittenItem[] = toWrite.map((i) => {
        const it = { bill_id: i.billId, issued_at: i.issuedAt, sheet: props.sheet, first_row: r, last_row: r + i.rows.length - 1 };
        r += i.rows.length;
        return it;
      });
      setPrepared({ fileName: file.name, data, ranges: written, items, inFile, noSheet: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルを読めませんでした");
    } finally {
      setReading(false);
    }
  }

  function save() {
    if (!prepared || prepared.items.length === 0) return;
    const p = prepared;
    startSaving(async () => {
      // 先に記録を残す（ほかの人が同じ請求を先に書いていたら、ここで止まる）。そのあとファイルを渡す
      const res = await markExcelWritten(props.book, p.fileName, p.items);
      if (!res.ok) {
        setError(res.message ?? "記録できませんでした");
        return;
      }
      const type = p.fileName.toLowerCase().endsWith(".xlsm")
        ? "application/vnd.ms-excel.sheet.macroEnabled.12"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const url = URL.createObjectURL(new Blob([p.data as BlobPart], { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = p.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDone(
        `「${p.fileName}」に${p.items.length}件（${p.ranges.map((w) => rangeLabel(w, props.book === "company")).join("、")}）を書き足して、ダウンロードしました。いつもの保存場所のファイルに上書きしてください。`,
      );
      setPrepared(null);
      setInputKey((k) => k + 1);
      router.refresh();
    });
  }

  return (
    <div className="card form-section">
      <h2>{props.title}</h2>
      <p className="muted small">{props.hint}</p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>請求書№</th>
              <th>企業</th>
              <th className="num">合計（税込）</th>
              <th className="num">行</th>
              <th>{props.title}</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((i) => (
              <tr key={i.billId}>
                <td className="nowrap">{i.invoiceNo}</td>
                <td>
                  <a href={`/bills/${i.billId}`}>{i.company}</a>
                </td>
                <td className="num nowrap">{yen(i.total)}</td>
                <td className="num">{i.lineCount}</td>
                <td>
                  {i.written ? (
                    <>
                      <span className="badge badge-active">記入済み</span>{" "}
                      <span className="small muted">
                        {i.written.sheet} {i.written.firstRow}
                        {i.written.lastRow !== i.written.firstRow && `〜${i.written.lastRow}`}行目（{dateTimeLabel(i.written.at)}）
                      </span>
                      {i.reissuedAfterWrite && (
                        <p className="notice notice-warn small">
                          書いたあとに請求書を作り直しています。Excelの行を手で直すか、行を消して「記入を取り消す」を押してから、もう一度書いてください。
                        </p>
                      )}
                      {props.canEdit && (
                        <form action={unmarkExcelWritten} style={{ display: "inline" }}>
                          <input type="hidden" name="bill_id" value={i.billId} />
                          <input type="hidden" name="book" value={props.book} />
                          <ConfirmButton
                            message={`${i.company}（${i.invoiceNo}）の「${props.title}に記入済み」を取り消します。Excelの行は消えません（手で消してください）。取り消すと、もう一度書けるようになります。よろしいですか？`}
                          >
                            記入を取り消す
                          </ConfirmButton>
                        </form>
                      )}
                    </>
                  ) : (
                    <span className="badge">まだ</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {props.canEdit && notYet.length === 0 && <p className="muted">この月の請求は、すべて{props.title}に記入済みです。</p>}

      {props.canEdit && notYet.length > 0 && (
        <>
          <p>
            まだ書いていない請求が<strong>{notYet.length}件</strong>
            （{notYet.reduce((s, i) => s + i.lineCount, 0)}行）あります。{props.title}のファイルを選んでください。
          </p>
          <input
            key={inputKey}
            type="file"
            accept=".xlsx,.xlsm"
            onChange={(ev) => onFile(ev.target.files?.[0])}
            disabled={reading || saving}
          />
          {reading && <p className="muted">読んでいます…</p>}
        </>
      )}

      {error && <p className="notice notice-error">{error}</p>}
      {done && <p className="notice notice-info">{done}</p>}

      {prepared && (
        <div className="excel-prepared">
          {prepared.inFile.length > 0 && (
            <p className="notice notice-warn">
              ファイルにもう書いてある請求がありました（{prepared.inFile.map((i) => `${i.company} ${i.invoiceNo}`).join("、")}）。この請求は書きません。
            </p>
          )}
          {prepared.noSheet.length > 0 && (
            <p className="notice notice-warn">
              企業シートに、この企業のシートが見つかりませんでした（{prepared.noSheet.map((i) => `${i.company} ${i.invoiceNo}`).join("、")}）。この請求は書きません。
            </p>
          )}
          {prepared.items.length > 0 ? (
            <>
              {props.book === "company" ? (
                <p>
                  「{prepared.fileName}」の <strong>{prepared.ranges.map((w) => rangeLabel(w, true)).join("、")}</strong>に、
                  {prepared.items.length}件を書き足します。
                </p>
              ) : (
                <p>
                  「{prepared.fileName}」の「{props.sheet}」シートの <strong>{prepared.ranges.map((w) => rangeLabel(w, false)).join("、")}</strong>に、
                  {prepared.items.length}件を書き足します。
                </p>
              )}
              <button type="button" className="btn" onClick={save} disabled={saving}>
                {saving ? "書いています…" : "書き足して保存する"}
              </button>
            </>
          ) : (
            <p className="muted">書き足す請求はありません。</p>
          )}
        </div>
      )}
    </div>
  );
}
