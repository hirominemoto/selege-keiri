"use client";

import { useActionState, useState } from "react";
import { importLegacyRows } from "@/app/(app)/companies/import-sheet/actions";
import { extractLegacyRows, type SheetResult } from "@/lib/legacySheet";
import { readWorkbook } from "@/lib/xlsx";
import { yen } from "@/lib/format";
import type { FormState } from "@/lib/form";

type CompanyRef = { id: string; name: string; aliases: string[] };

/**
 * 企業シート（旧Excel）を選ぶと、ブラウザの中で読んで、企業ごとの行を見せる。
 * 「取り込む」で、読んだ行だけをサーバーに送る（Excelファイルそのものは送らない）
 */
export function LegacyImportForm({ companies, alreadyImported }: { companies: CompanyRef[]; alreadyImported: number }) {
  const [results, setResults] = useState<SheetResult[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(importLegacyRows, {});

  const matched = (results ?? []).filter((r) => r.company_id && r.rows.length > 0);
  const unmatched = (results ?? []).filter((r) => !r.company_id && r.rows.length > 0);
  const skipped = (results ?? []).flatMap((r) => r.skipped.map((s) => ({ ...s, sheet: r.sheet_name })));
  const rows = matched.flatMap((r) => r.rows);
  const lastDate = rows.map((r) => r.issue_date).sort().at(-1);

  async function onFile(file: File | undefined) {
    setResults(null);
    setReadError(null);
    if (!file) return;
    setFileName(file.name);
    setReading(true);
    try {
      const sheets = await readWorkbook(await file.arrayBuffer());
      const res = extractLegacyRows(sheets, companies);
      if (res.length === 0) setReadError("企業ごとのシートが見つかりませんでした。企業シートのファイルか確かめてください");
      setResults(res);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "ファイルを読めませんでした");
    } finally {
      setReading(false);
    }
  }

  return (
    <>
      <div className="card form-section">
        <h2>1. 企業シートを選ぶ</h2>
        <p className="muted small">
          ファイルはこのパソコンのブラウザの中だけで読みます。サーバーに送るのは、下の表の行（請求日・案件名・金額など）だけです。
        </p>
        <input type="file" accept=".xlsm,.xlsx" onChange={(ev) => onFile(ev.target.files?.[0])} disabled={reading || pending} />
        {reading && <p className="muted">読んでいます…</p>}
        {readError && <p className="notice notice-error">{readError}</p>}
      </div>

      {results && matched.length > 0 && (
        <div className="card form-section">
          <h2>2. 中身を確かめる</h2>
          <div className="summary-chips">
            <span>
              取り込む企業 <strong>{matched.length}社</strong>
            </span>
            <span>
              行 <strong>{rows.length}行</strong>
            </span>
            <span>
              いちばん新しい請求日 <strong>{lastDate}</strong>
            </span>
          </div>

          <details>
            <summary>企業ごとの行数を見る（{matched.length}社）</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>アプリの企業</th>
                    <th>シート名</th>
                    <th>行</th>
                    <th>いちばん新しい請求日</th>
                    <th>金額の合計（税抜）</th>
                  </tr>
                </thead>
                <tbody>
                  {matched.map((r) => (
                    <tr key={r.sheet_name}>
                      <td>{r.company_name}</td>
                      <td className="muted">{r.sheet_name}</td>
                      <td>{r.rows.length}</td>
                      <td>{r.rows.map((x) => x.issue_date).sort().at(-1)}</td>
                      <td>{yen(r.rows.reduce((s, x) => s + x.amount, 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {unmatched.length > 0 && (
            <div className="notice notice-info">
              <p>
                アプリに登録していない企業のシートが {unmatched.length} 枚ありました。これは取り込みません（今は取引のない企業が多いはずです）。
                必要な企業があれば、「企業・契約」で登録してから、もう一度取り込んでください。
              </p>
              <p className="small">{unmatched.map((r) => r.client_name).join("、")}</p>
            </div>
          )}

          {skipped.length > 0 && (
            <details>
              <summary>読み飛ばした行（{skipped.length}行）</summary>
              <ul className="small">
                {skipped.map((s) => (
                  <li key={`${s.sheet}-${s.row_no}`}>
                    {s.sheet} の {s.row_no} 行目：{s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {results && matched.length > 0 && (
        <form action={action} className="card form-section">
          <h2>3. 取り込む</h2>
          <p>
            {fileName} の {rows.length} 行を取り込みます。
            {alreadyImported > 0 && `今ある取り込み済みの ${alreadyImported} 行は、この内容に入れ替わります。`}
            アプリで入力した請求や、企業・契約には触りません。
          </p>
          <input type="hidden" name="rows" value={JSON.stringify(rows)} />
          <button type="submit" className="btn" disabled={pending}>
            {pending ? "取り込んでいます…" : "取り込む"}
          </button>
          {state.message && <p className={`notice ${state.ok ? "notice-info" : "notice-error"}`}>{state.message}</p>}
        </form>
      )}
    </>
  );
}
