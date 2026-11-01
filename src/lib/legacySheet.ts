/**
 * 企業シート（旧Excel・もとの社内申込書）から、企業ごとの請求の行を取り出す
 * シートの形（解析メモ docs/excel-structure.md）：
 *   B2 クライアント名、6行目が見出し、7行目から
 *   A 請求日｜B クライアント名｜C 案件名｜D 単価｜E 個数｜F 売上金額（税抜）｜G 備考｜H 計上月｜I 支払期限
 */
import { excelDate, type CellValue, type SheetData } from "./xlsx";

export const NOT_COMPANY_SHEETS = new Set(["目次", "申込書", "Sheet1", "データ"]);

export type LegacyRow = {
  company_id: string;
  sheet_name: string;
  row_no: number;
  issue_date: string;
  description: string;
  unit_price: number | null;
  quantity: number | null;
  amount: number;
  note: string | null;
  sheet_month_label: string | null;
  payment_due_date: string | null;
};

export type SheetResult = {
  sheet_name: string;
  client_name: string;
  company_id: string | null;
  company_name: string | null;
  rows: LegacyRow[];
  skipped: { row_no: number; reason: string }[];
};

const z2h = (s: string) => s.normalize("NFKC");

/** 「株式会社渡邊金属（5月）」→「株式会社渡邊金属」 */
export function stripMonth(name: string): string {
  return name.replace(/[（(]\s*[0-9０-９]+\s*月分?\s*[）)]\s*$/, "").trim();
}

/** 表記ゆれを同じにみなすための鍵（tools/extract_import.py の name_key と同じ考え方） */
export function nameKey(n: string): string {
  let k = z2h(n).replace(/\s+/g, "");
  k = k.replace(/\d+$/, "");
  k = k.replace(/(株式会社|株式會社|有限会社|合同会社|\(株\)|\(有\)|㈱|㈲)/g, "");
  k = k.replace(/渡邉|渡辺/g, "渡邊").replace(/[―‐－-]/g, "ー");
  k = k.replace(/(工作所|製作所|工業)$/, "");
  return k;
}

const str = (v: CellValue | undefined): string => (v === null || v === undefined ? "" : String(v)).trim();

function num(v: CellValue | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = z2h(v).replace(/[,円\s]/g, "");
    if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  }
  return null;
}

/**
 * 企業シートのブックから、企業ごとの行を取り出す
 * companies: アプリの企業（名前）と別名。名前の鍵で突き合わせる
 */
export function extractLegacyRows(
  sheets: SheetData[],
  companies: { id: string; name: string; aliases: string[] }[],
): SheetResult[] {
  const byKey = new Map<string, { id: string; name: string }>();
  for (const c of companies) {
    for (const n of [c.name, ...c.aliases]) {
      const k = nameKey(stripMonth(n));
      if (k && !byKey.has(k)) byKey.set(k, { id: c.id, name: c.name });
    }
  }

  const results: SheetResult[] = [];
  for (const sheet of sheets) {
    if (NOT_COMPANY_SHEETS.has(sheet.name)) continue;
    const head = sheet.rows.get(6);
    if (!head || !str(head.get(1)).includes("請求日")) continue; // 企業のシートの形でないものは飛ばす

    const client = stripMonth(str(sheet.rows.get(2)?.get(2)));
    const hit = byKey.get(nameKey(client)) ?? byKey.get(nameKey(stripMonth(sheet.name)));
    const result: SheetResult = {
      sheet_name: sheet.name,
      client_name: client || sheet.name,
      company_id: hit?.id ?? null,
      company_name: hit?.name ?? null,
      rows: [],
      skipped: [],
    };

    const rowNos = [...sheet.rows.keys()].filter((r) => r >= 7).sort((a, b) => a - b);
    for (const r of rowNos) {
      const cells = sheet.rows.get(r)!;
      const issue = excelDate(cells.get(1) ?? null);
      const description = str(cells.get(3));
      if (!issue && !description) continue; // 空の行・式だけの行
      if (!issue) {
        result.skipped.push({ row_no: r, reason: "請求日が読めません" });
        continue;
      }
      if (!description) {
        result.skipped.push({ row_no: r, reason: "案件名が空です" });
        continue;
      }
      const unit = num(cells.get(4));
      const qty = num(cells.get(5));
      let amount = num(cells.get(6));
      if (amount === null && unit !== null && qty !== null) amount = unit * qty;
      if (amount === null) {
        result.skipped.push({ row_no: r, reason: "売上金額が読めません" });
        continue;
      }
      result.rows.push({
        company_id: hit?.id ?? "",
        sheet_name: sheet.name,
        row_no: r,
        issue_date: issue,
        description,
        unit_price: unit === null ? null : Math.round(unit),
        quantity: qty,
        amount: Math.round(amount),
        note: str(cells.get(7)) || null,
        sheet_month_label: str(cells.get(8)) || null,
        payment_due_date: excelDate(cells.get(9) ?? null),
      });
    }
    results.push(result);
  }
  return results;
}
